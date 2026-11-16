import { execFile } from "node:child_process"
import { Plugin } from "@opencode/plugin"

// OpenCode's `cmd` shell escapes double quotes before handing a command to
// cmd.exe, so a quoted launcher path arrives as \"C:\...\snip.exe\" and fails
// with "is not recognized". Quoting is only needed when the path contains
// whitespace or a cmd metacharacter, so drop it otherwise. Only cmd has this
// problem, and only launchers at the start of a command segment are rewritten:
// argument text must stay untouched.
const QUOTED_LAUNCHER = /(^|&&|\|\||[|;])(\s*)"([^"\r\n]+)"(?=\s+run --\s)/g
const NEEDS_QUOTES = /[\s&|<>^()%!]/

export function unquoteLauncher(command: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return command
  return command.replace(QUOTED_LAUNCHER, (match, separator: string, space: string, launcher: string) =>
    NEEDS_QUOTES.test(launcher) ? match : `${separator}${space}${launcher}`,
  )
}

// Delegates to `snip hook` (Claude Code PreToolUse format) so the rewrite rules
// stay in snip: only filtered commands are wrapped, pipes/redirects/heredocs and
// command substitutions are left raw. Any failure leaves the command untouched.
export function rewrite(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile("snip", ["hook"], { timeout: 2000, windowsHide: true }, (error, stdout) => {
      if (error || !stdout.trim()) return resolve(undefined)
      try {
        const rewritten = JSON.parse(stdout).hookSpecificOutput?.updatedInput?.command
        resolve(typeof rewritten === "string" ? unquoteLauncher(rewritten) : undefined)
      } catch {
        resolve(undefined)
      }
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(JSON.stringify({ tool_name: "Bash", tool_input: { command } }))
  })
}

export const toolExecuteBefore = async (event: { tool: string; input: unknown }) => {
  if (event.tool !== "shell") return

  const input = event.input as { command?: unknown } | undefined
  const command = input?.command
  if (!command || typeof command !== "string") return

  const rewritten = await rewrite(command)
  if (rewritten) event.input = { ...input, command: rewritten }
}

// `snip hook` emits `[assignments] [runner] "<snip>"[ --plugin-config ...] run -- <command>`.
// Drop the assignments, keep the runner, and unwrap one snip layer so rules and
// saved approvals match the command the shell scanner checks. Only snip's own
// transparent prefixes can precede the launcher (internal/hook/transparent.go);
// any other word there means the launcher is an argument, not a wrapper.
const NAME = String.raw`[A-Za-z_][A-Za-z0-9_]*`
const ASSIGNMENT = String.raw`${NAME}\+?=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s\\]|\\.)*\s+`
const BARE_COMMAND = new RegExp(`^(?:${ASSIGNMENT})*`)
const RUNNER = String.raw`(?:(?:uv|poetry|pdm|pipenv|rye|hatch) run(?: --?[-\w.:=/]+(?: [^-\s]\S*)?)*|noglob|nocorrect|command|exec)\s+`
const BIN = String.raw`(?:"(?:[^"\\]|\\.)*[\\/]snip(?:\.exe)?"|"snip(?:\.exe)?"|(?:[^\s"']*[\\/])?snip(?:\.exe)?)`
const REST = String.raw`\s+(?:--plugin-config\s+(?:"(?:[^"\\]|\\.)*"|\S+)\s+)?(?:run\s+)?--\s+`
const SNIP_RUN = new RegExp(
  `^(?:${ASSIGNMENT})*(?<runner>${RUNNER})?(?<launcher>${BIN})${REST}(?<command>[\\s\\S]+)$`,
)

function snipGroups(command: string) {
  return SNIP_RUN.exec(command)?.groups
}

export function launcherOf(rewritten: string | undefined): string | undefined {
  return rewritten ? snipGroups(rewritten)?.launcher : undefined
}

// Only the launcher this plugin runs may be unwrapped: another executable named
// snip (`./snip`, `/tmp/snip`) would borrow the wrapped command's permission.
function unwrapSnip(resource: string, launcher: string): string | undefined {
  const groups = snipGroups(resource)
  if (!groups || groups.launcher !== launcher) return undefined
  return `${groups.runner ?? ""}${groups.command}`
}

// Allow-always saves the first word of the command in this commit.
const firstWord = (command: string) => command.trim().replace(BARE_COMMAND, "").split(/\s+/)[0]

export const SnipPlugin = Plugin.define({
  id: "opencode-snip",
  async setup(ctx) {
    // Probes `snip hook` rather than the binary alone: a snip without the hook
    // subcommand would otherwise leave every command unfiltered silently.
    // The probe also yields the launcher the plugin runs, the only one trusted
    // when permissions are re-checked.
    const launcher = launcherOf(await rewrite("git status"))
    if (!launcher) {
      console.warn("[snip] snip hook unavailable (binary missing or too old) — plugin disabled")
      return
    }
    const permission = ctx.permission
    const tools = await ctx.tool.hook("execute.before", toolExecuteBefore)
    if (typeof permission.assert !== "function") {
      console.warn("[snip] permission.assert unavailable (opencode too old) — allow always will not be saved")
      return tools.dispose
    }
    // Permissions are checked after `execute.before` rewrites the command, so
    // rules would match the snip wrapper. Re-check the unwrapped command and
    // settle the original decision, keeping rules and saved approvals intact.
    const permissions = await permission.hook("evaluate", async (event) => {
      if (event.action !== "shell") return
      const unwrapped = event.resources.map((resource) => unwrapSnip(resource, launcher))
      if (unwrapped.every((command) => command === undefined)) return
      // Mixed commands keep their unwrapped segments in the re-check.
      const commands = unwrapped.map((command, index) => command ?? event.resources[index])
      try {
        await permission.assert({
          sessionID: event.sessionID,
          ...(event.agent ? { agent: event.agent } : {}),
          action: event.action,
          resources: commands,
          save: commands.map((command) => `${firstWord(command)} *`),
          ...(event.source ? { source: event.source } : {}),
        })
        event.effect = "allow"
      } catch (error) {
        event.effect = "deny"
        event.message = error instanceof Error ? error.message : String(error)
      }
    })
    return async () => {
      await tools.dispose()
      await permissions.dispose()
    }
  },
})

export default SnipPlugin
