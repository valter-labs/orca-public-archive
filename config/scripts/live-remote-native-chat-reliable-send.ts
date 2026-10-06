import { appendFileSync, chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page
} from '@stablyai/playwright-test'
import { z } from 'zod'
import '../../tests/e2e/helpers/runtime-types'
import { getE2ECompletedOnboardingProfile } from '../../tests/e2e/helpers/e2e-completed-onboarding-profile'
import { getOrcaElectronLaunchArgs } from '../../tests/e2e/helpers/electron-launch-args'
import {
  createElectronHomeIsolation,
  assertElectronResolvedIsolatedHome
} from '../../tests/e2e/helpers/electron-home-isolation'
import { selectPairedRuntimeEnvironment } from '../../tests/e2e/helpers/paired-client-runtime-environment'
import {
  cleanupE2EDaemons,
  closeElectronAppForE2E
} from '../../tests/e2e/helpers/electron-process-shutdown'

// pnpm exec jiti config/scripts/live-remote-native-chat-reliable-send.ts <private-pairing-file> <codex|claude> <session-UUID> <transcript-path|-> <worktree-id> <tab-label>
const sourceInput = process.env.ORCA_LIVE_CHAT_RUNTIME_SOURCE ?? ''
const runtimeSource = /^[a-f0-9]{40}$/.test(sourceInput) ? sourceInput : 'unknown'
const [pairingFile, agentInput, sessionInput, transcriptInput, worktreeId, tabLabel] =
  process.argv.slice(2)
const agent = z.enum(['codex', 'claude']).safeParse(agentInput)
const session = z.string().uuid().safeParse(sessionInput)
if (!pairingFile || !agent.success || !session.success || !worktreeId || !tabLabel) {
  process.stdout.write('{"ok":false,"stage":"arguments"}\n')
  process.exit(2)
}
const transcriptPath = transcriptInput === '-' ? undefined : transcriptInput
const evidenceDir = mkdtempSync(path.join(os.tmpdir(), 'orca-live-reliable-chat-'))
chmodSync(evidenceDir, 0o700)
const privateLogPath = path.join(evidenceDir, 'errors-private.jsonl')
const privateLog = (detail: unknown) => {
  const payload = detail instanceof Error ? detail.stack : detail
  appendFileSync(privateLogPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 })
}
const profile = path.join(evidenceDir, 'profile')
const fixture = getE2ECompletedOnboardingProfile()
const isolation = createElectronHomeIsolation({
  inheritedEnv: Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/TOKEN|SECRET|API_KEY|^ORCA_|ELECTRON_RUN_AS_NODE/.test(key)
    )
  ),
  launchEnv: {},
  extraEnv: {},
  userDataDir: profile
})
const settings = { ...fixture.settings, experimentalNativeChat: true, language: 'en' }
writeFileSync(path.join(profile, 'orca-data.json'), JSON.stringify({ ...fixture, settings }), {
  mode: 0o600
})
const nonce = `orca-live-${randomUUID()}`
const prompt = `Reply with exactly this text and nothing else: ${nonce}`
const transcriptSchema = z.object({
  sessionId: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.string(),
      source: z.string(),
      blocks: z.array(z.object({ type: z.string(), text: z.string().optional() }))
    })
  )
})
const missingTranscript = z.object({ error: z.string(), notFound: z.literal(true) })
let app: ElectronApplication | undefined
let page: Page | undefined
let stage = 'launch'
let ok = false
let counts = { user: 0, assistant: 0 }
const diagnostics = { consoleErrors: 0, pageErrors: 0, networkErrors: 0, readErrors: 0 }
const screenshotPath = path.join(evidenceDir, 'screen.png')
const cleanupFailed = () => {
  process.exitCode = 1
  ok = false
}
try {
  app = await electron.launch({
    args: getOrcaElectronLaunchArgs(path.join(process.cwd(), 'out/main/index.js'), false),
    env: {
      ...isolation.env,
      ORCA_USER_DATA_PATH: profile,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_E2E_HEADLESS: '1',
      NODE_ENV: 'development'
    }
  })
  assertElectronResolvedIsolatedHome(
    await app.evaluate(({ app: mainApp }) => mainApp.getPath('home')),
    isolation
  )
  page = await app.firstWindow({ timeout: 120_000 })
  page.on('console', (message) => {
    if (message.type() === 'error') {
      diagnostics.consoleErrors++
      privateLog({ console: message.text() })
    }
  })
  page.on('pageerror', (error) => {
    diagnostics.pageErrors++
    privateLog({ pageerror: error.stack })
  })
  page.on('response', (response) => {
    if (response.status() >= 400) {
      diagnostics.networkErrors++
      privateLog({ network: { status: response.status(), url: response.url() } })
    }
  })
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(
    () => window.__store?.getState().workspaceSessionReady === true,
    null,
    { timeout: 60_000 }
  )
  stage = 'pairing-precondition'
  const environmentId = await selectPairedRuntimeEnvironment(page, {
    name: 'Live reliable Chat',
    pairingUrl: readFileSync(pairingFile, 'utf8').trim(),
    reusedProfile: false
  })
  const binding = await page.evaluate(async (id) => {
    const environment = (await window.api.runtimeEnvironments.list()).find(
      (entry) => entry.id === id
    )
    if (!environment?.runtimeId) {
      throw new Error('runtime_identity_unavailable')
    }
    return {
      revision: environment.pairingRevision ?? environment.createdAt,
      runtimeId: environment.runtimeId
    }
  }, environmentId)
  const readCounts = async (allowMissing = false) => {
    const response = await page!.evaluate(
      async (args) =>
        window.api.runtimeEnvironments.call({
          selector: args.environmentId,
          method: 'nativeChat.readSession',
          params: {
            agent: args.agent,
            sessionId: args.sessionId,
            limit: 100,
            transcriptPath: args.transcriptPath
          },
          expectedEnvironmentPairingRevision: args.revision,
          expectedEnvironmentRuntimeId: args.runtimeId
        }),
      { environmentId, agent: agent.data, sessionId: session.data, transcriptPath, ...binding }
    )
    if (!response.ok) {
      throw new Error('transcript_rpc_failed')
    }
    if (response._meta?.runtimeId !== binding.runtimeId) {
      throw new Error('transcript_runtime_identity_changed')
    }
    if (allowMissing && missingTranscript.safeParse(response.result).success) {
      return { user: 0, assistant: 0 }
    }
    const transcript = transcriptSchema.parse(response.result)
    if (transcript.sessionId && transcript.sessionId !== session.data) {
      throw new Error('transcript_session_identity_changed')
    }
    const hasNonce = (message: z.infer<typeof transcriptSchema>['messages'][number]) =>
      message.source === 'transcript' &&
      message.blocks.some((block) => block.type === 'text' && block.text?.includes(nonce))
    const count = (role: string) =>
      transcript.messages.filter((message) => message.role === role && hasNonce(message)).length
    return { user: count('user'), assistant: count('assistant') }
  }
  stage = 'session-precondition'
  expect(await readCounts(true)).toEqual({ user: 0, assistant: 0 })
  stage = 'worktree-ui'
  await page
    .locator(
      `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(worktreeId)}]`
    )
    .click({ timeout: 60_000 })
  stage = 'terminal-tab-ui'
  const tab = page.locator('[data-tab-id]').filter({ hasText: tabLabel })
  await expect(tab).toHaveCount(1, { timeout: 30_000 })
  await tab.click()
  stage = 'chat-toggle-ui'
  const showChat = page.getByRole('button', { name: 'Show chat view', exact: true })
  const showTerminal = page.getByRole('button', { name: 'Show terminal', exact: true })
  await expect(showChat.or(showTerminal)).toBeVisible({ timeout: 30_000 })
  if (await showChat.isVisible()) {
    await showChat.click()
  }
  const editor = page.locator('[role="textbox"][contenteditable="true"][aria-multiline="true"]')
  await expect(editor).toHaveCount(1)
  stage = 'type-ui'
  await editor.click()
  await page.keyboard.type(prompt, { delay: 10 })
  await expect(editor).toHaveText(prompt)
  stage = 'send-ui'
  expect(
    await page.evaluate(() => window.__store?.getState().settings?.activeRuntimeEnvironmentId)
  ).toBe(environmentId)
  const send = page.getByRole('button', { name: 'Send', exact: true })
  await expect(send).toBeEnabled({ timeout: 30_000 })
  await send.click()
  stage = 'canonical-transcript'
  await expect
    .poll(
      async () => {
        try {
          counts = await readCounts()
          return counts
        } catch (error) {
          diagnostics.readErrors++
          privateLog(error)
          return { user: 0, assistant: 0 }
        }
      },
      { timeout: 120_000, intervals: [500, 1_000, 2_000] }
    )
    .toEqual({ user: 1, assistant: 1 })
  ok = true
  stage = 'complete'
} catch (error) {
  process.exitCode = 1
  privateLog(error)
} finally {
  if (page) {
    await page
      .screenshot({ path: screenshotPath })
      .then(() => chmodSync(screenshotPath, 0o600))
      .catch(() => undefined)
  }
  if (app) {
    await closeElectronAppForE2E(app).catch(cleanupFailed)
  }
  await cleanupE2EDaemons(profile).catch(cleanupFailed)
  const summary = {
    ok,
    stage,
    runtimeSource,
    counts,
    requiredCounts: { user: 1, assistant: 1 },
    diagnostics,
    screenshotPath,
    evidenceDir
  }
  writeFileSync(path.join(evidenceDir, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o600
  })
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}
