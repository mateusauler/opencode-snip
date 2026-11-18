import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { SnipPlugin, launcherOf, rewrite, toolExecuteBefore, unquoteLauncher } from "./index"
import { savePattern } from "./prefix"

// Same probe as the plugin startup: an old snip without `hook` skips these tests.
const probe = await rewrite("git status")
const hasSnipHook = probe !== undefined

// snip quotes its launcher path; the plugin unquotes it on Windows when the
// path needs no quotes. Accept either form so the suite passes everywhere.
const SNIP_LAUNCHER = /(?:"[^"\r\n]*snip(?:\.exe)?"|[^\s"&|<>^()%!]*snip(?:\.exe)?)/
const SNIP_RUN = new RegExp(`^${SNIP_LAUNCHER.source} run -- `)
// The launcher the plugin trusts, as its own probe emitted it.
const launcher = launcherOf(probe) ?? ""

describe("toolExecuteBefore", () => {
  async function run(command: string, tool = "shell") {
    const event: { tool: string; input: unknown } = { tool, input: { command } }
    await toolExecuteBefore(event)
    return (event.input as { command: string }).command
  }

  it("should not modify non-shell tool calls", async () => {
    expect(await run("git status", "read")).toBe("git status")
  })

  describe.skipIf(!hasSnipHook)("with snip", () => {
    it("should wrap a command snip has a filter for", async () => {
      const command = await run("git status")
      expect(command).toMatch(SNIP_RUN)
      expect(command).toMatch(/ run -- git status$/)
    })

    it("should keep env var prefixes before snip", async () => {
      expect(await run("CGO_ENABLED=0 go test ./...")).toMatch(
        new RegExp(`^CGO_ENABLED=0 ${SNIP_LAUNCHER.source} run -- go test \\.\\/\\.\\.\\.$`),
      )
    })

    it("should wrap each segment of a compound command", async () => {
      expect(await run("git status && git log -5")).toMatch(
        new RegExp(` run -- git status && ${SNIP_LAUNCHER.source} run -- git log -5$`),
      )
    })

    it("should not double wrap an already wrapped command", async () => {
      const wrapped = await run("git status")
      expect(await run(wrapped)).toBe(wrapped)
    })

    it.each([
      ["shell builtin", "cd /tmp"],
      ["command without filter", "echo hello"],
      ["head feeding a pipe", "git log | head"],
      ["head feeding a redirect", "go test ./... > out.txt"],
      ["command substitution", "git log $(git rev-parse HEAD)"],
      ["heredoc", "cat <<EOF\ngit status\nEOF"],
    ])("should leave %s untouched", async (_, command) => {
      expect(await run(command)).toBe(command)
    })
  })

  describe("when snip is not reachable", () => {
    const path = process.env.PATH

    beforeEach(() => {
      process.env.PATH = ""
      vi.spyOn(console, "warn").mockImplementation(() => {})
    })

    afterEach(() => {
      process.env.PATH = path
      vi.restoreAllMocks()
    })

    it("should leave the command untouched", async () => {
      expect(await run("git status")).toBe("git status")
    })

    it("should disable the plugin", async () => {
      const hook = vi.fn()
      await SnipPlugin.setup({
        tool: { hook },
        permission: { hook: vi.fn(), assert: vi.fn() },
      } as unknown as Parameters<typeof SnipPlugin.setup>[0])
      expect(hook).not.toHaveBeenCalled()
    })
  })
})

describe("unquoteLauncher", () => {
  it("should unquote a launcher path without whitespace on Windows", () => {
    expect(unquoteLauncher('"C:\\tools\\snip.exe" run -- git status', "win32")).toBe(
      "C:\\tools\\snip.exe run -- git status",
    )
  })

  it("should keep the quotes when the path contains whitespace", () => {
    const command = '"C:\\Program Files\\snip.exe" run -- git status'
    expect(unquoteLauncher(command, "win32")).toBe(command)
  })

  it("should keep the quotes when the path contains cmd metacharacters", () => {
    const command = '"C:\\tools&more\\snip.exe" run -- git status'
    expect(unquoteLauncher(command, "win32")).toBe(command)
  })

  it("should unquote every segment of a compound command", () => {
    const command = '"/usr/local/bin/snip" run -- git status && "/usr/local/bin/snip" run -- git log'
    expect(unquoteLauncher(command, "win32")).toBe(
      "/usr/local/bin/snip run -- git status && /usr/local/bin/snip run -- git log",
    )
  })

  it("should leave argument text untouched", () => {
    const command = `git log --grep='"release" run -- tests'`
    expect(unquoteLauncher(command, "win32")).toBe(command)
  })

  it("should not rewrite anything outside Windows", () => {
    const command = '"/home/me/tools(1)/snip" run -- git status'
    expect(unquoteLauncher(command, "linux")).toBe(command)
  })

  it("should leave commands that are not snip wrappers untouched", () => {
    expect(unquoteLauncher('echo "hello world"', "win32")).toBe('echo "hello world"')
  })
})

type Evaluate = (event: PermissionEvaluation) => Promise<void>

describe.skipIf(!hasSnipHook)("permission hook", () => {
  async function setup() {
    let evaluate: Evaluate | undefined
    const disposeTool = vi.fn()
    const disposePermission = vi.fn()
    const context = {
      tool: { hook: vi.fn(async () => ({ dispose: disposeTool })) },
      permission: {
        assert: vi.fn(async () => {}),
        hook: vi.fn(async (_name: string, callback: Evaluate) => {
          evaluate = callback
          return { dispose: disposePermission }
        }),
      },
    }
    const cleanup = await SnipPlugin.setup(context as unknown as Parameters<typeof SnipPlugin.setup>[0])
    return { context, cleanup, evaluate: evaluate!, disposeTool, disposePermission }
  }

  const evaluation = (overrides: Partial<PermissionEvaluation> = {}): PermissionEvaluation => ({
    sessionID: "ses_test" as PermissionEvaluation["sessionID"],
    action: "shell",
    resources: [`${launcher} run -- git status`],
    effect: "allow",
    ...overrides,
  })

  it("re-checks the unwrapped command", async () => {
    const { context, evaluate } = await setup()
    const event = evaluation()
    await evaluate(event)
    expect(context.permission.assert).toHaveBeenCalledWith({
      sessionID: "ses_test",
      action: "shell",
      resources: ["git status"],
      save: ["git status *"],
    })
    expect(event.effect).toBe("allow")
  })

  it.each([
    [`${launcher} run -- git status`, "git status"],
    [`${launcher} -- git status`, "git status"],
    [`CGO_ENABLED=0 ${launcher} run -- git status`, "git status"],
    [`FOO="a b" ${launcher} run -- git status`, "git status"],
    [`${launcher} --plugin-config /tmp/snip.toml run -- git status`, "git status"],
    [`uv run ${launcher} run -- pytest`, "uv run pytest"],
    [`poetry run ${launcher} run -- git status`, "poetry run git status"],
    [`CGO_ENABLED=0 uv run ${launcher} run -- pytest`, "uv run pytest"],
    [`uv run --python 3.12 ${launcher} run -- pytest`, "uv run --python 3.12 pytest"],
    [`command ${launcher} run -- git status`, "command git status"],
    [`PAGER= ${launcher} run -- git log`, "git log"],
    [`FOO=a\\ b ${launcher} run -- git status`, "git status"],
  ])("unwraps %s", async (resource, expected) => {
    const { context, evaluate } = await setup()
    await evaluate(evaluation({ resources: [resource] }))
    expect(context.permission.assert).toHaveBeenCalledWith(expect.objectContaining({ resources: [expected] }))
  })

  it.each([`echo snip -- hello`, `echo ${launcher} run -- hello`, `xargs ${launcher} run -- rm`])(
    "leaves %s alone: the launcher is an argument, not a wrapper",
    async (resource) => {
      const { context, evaluate } = await setup()
      const event = evaluation({ resources: [resource] })
      await evaluate(event)
      expect(context.permission.assert).not.toHaveBeenCalled()
      expect(event.effect).toBe("allow")
    },
  )

  it.each(["/tmp/snip", "./snip", "/usr/local/bin/snip"])(
    "leaves %s alone: only the launcher this plugin runs is unwrapped",
    async (other) => {
      const { context, evaluate } = await setup()
      const event = evaluation({ resources: [`${other} run -- git status`] })
      await evaluate(event)
      expect(context.permission.assert).not.toHaveBeenCalled()
      expect(event.effect).toBe("allow")
    },
  )

  it("leaves commands the plugin did not wrap alone", async () => {
    const { context, evaluate } = await setup()
    const event = evaluation({ resources: ["echo hello", "git log | head"] })
    await evaluate(event)
    expect(context.permission.assert).not.toHaveBeenCalled()
    expect(event.effect).toBe("allow")
  })

  it("re-checks wrapped and unwrapped segments of a mixed command", async () => {
    const { context, evaluate } = await setup()
    const event = evaluation({
      resources: [`${launcher} run -- git status`, "echo hi"],
      effect: "ask",
    })
    await evaluate(event)
    expect(context.permission.assert).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: ["git status", "echo hi"],
        save: ["git status *", "echo *"],
      }),
    )
    expect(event.effect).toBe("allow")
  })

  it.each([
    "FOO=bar",
    "FOO=",
    "FOO='a b'",
    "FOO='a\\ b'",
    "FOO=a\\ b",
    'FOO="a b"',
    'FOO=a"b c"',
    "FOO=$'a b'",
    "FOO=1 BAR='x y'",
    "FOO+=bar",
  ])("saves the command without its leading assignment (%s)", async (assignment) => {
    const { context, evaluate } = await setup()
    await evaluate(evaluation({ resources: [`${launcher} run -- git status`, `${assignment} echo hi`] }))
    expect(context.permission.assert).toHaveBeenCalledWith(
      expect.objectContaining({ save: ["git status *", "echo *"] }),
    )
  })

  it("forwards the calling agent to the re-check", async () => {
    const { context, evaluate } = await setup()
    await evaluate(evaluation({ agent: "agent_scoped" as PermissionEvaluation["agent"] }))
    expect(context.permission.assert).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "agent_scoped" }),
    )
  })

  it("keeps rewriting when the host has no permission.assert", async () => {
    const hook = vi.fn(async () => ({ dispose: vi.fn() }))
    const permission = { hook: vi.fn() }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await SnipPlugin.setup({
      tool: { hook },
      permission,
    } as unknown as Parameters<typeof SnipPlugin.setup>[0])
    expect(hook).toHaveBeenCalled()
    expect(permission.hook).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("denies when the real command is denied", async () => {
    const { context, evaluate } = await setup()
    context.permission.assert.mockRejectedValue(new Error("Permission denied: shell"))
    const event = evaluation()
    await evaluate(event)
    expect(event.effect).toBe("deny")
    expect(event.message).toBe("Permission denied: shell")
  })

  it("disposes both hooks", async () => {
    const { cleanup, disposeTool, disposePermission } = await setup()
    await cleanup?.()
    expect(disposeTool).toHaveBeenCalled()
    expect(disposePermission).toHaveBeenCalled()
  })
})

describe("savePattern", () => {
  it.each([
    ["git clone --depth 1 https://example.com/repo.git", "git clone *"],
    ["git status --short", "git status *"],
    ["git config user.name", "git config user.name *"],
    ["ls -la", "ls *"],
    ["rg TODO src", "rg *"],
    ["FOO=bar git status", "git status *"],
    ["CGO_ENABLED=0 ls -la", "ls *"],
    ["git \"a b\" status", "git \"a b\" *"],
    ["git a\\ b status", "git a\\ b *"],
    ["git > out status", "git *"],
    ["git >out status", "git *"],
    ["> out git status", "git status *"],
    ["git status 2>&1", "git status *"],
    ["git status > out", "git status *"],
    ["FOO=(a b) git status", "git status *"],
    ["FOO=$(a b) git status", "git status *"],
    ["FOO=$((1 + 2)) git status", "git status *"],
    ["git log>out", "git log *"],
    ["FOO+=bar git log", "git log *"],
  ])("saves the shell tool's prefix for %s", (command, saved) => {
    expect(savePattern(command)).toBe(saved)
  })
})
