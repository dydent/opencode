import { afterEach, beforeEach, expect, test } from "bun:test"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

const ports = {
  CLAUDE_CODE_SSE_PORT: process.env.CLAUDE_CODE_SSE_PORT,
  OPENCODE_EDITOR_SSE_PORT: process.env.OPENCODE_EDITOR_SSE_PORT,
}

beforeEach(() => {
  takeDraft(undefined)
  takeDraft("ses_ide_aliases")
  delete process.env.CLAUDE_CODE_SSE_PORT
  delete process.env.OPENCODE_EDITOR_SSE_PORT
})

afterEach(() => {
  Object.entries(ports).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key]
      return
    }
    process.env[key] = value
  })
})

const selected = {
  filePath: `${directory}/Main.kt`,
  text: 'println("UNSAVED λ")',
  selection: { start: { line: 12, character: 2 }, end: { line: 12, character: 22 } },
}

async function fixture(automatic = true) {
  const connected = Promise.withResolvers<void>()
  const reconnected = Promise.withResolvers<void>()
  let publishInitial = true
  let socket!: Bun.ServerWebSocket<undefined>
  const submitted = Promise.withResolvers<{ text: string; files?: { uri: string; name?: string }[] }>()
  const synthetic: unknown[] = []
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const sessionID = "ses_ide_aliases"
  const session = {
    id: sessionID,
    projectID: "project",
    title: "IDE aliases",
    agent: "build",
    model: { providerID: "demo", id: "model" },
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "mcp" } })) return
      return new Response(null, { status: 400 })
    },
    websocket: {
      message(current, data) {
        const message = JSON.parse(String(data))
        if (message.method === "initialize") {
          current.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "IDE" } } }))
        }
        if (message.method === "notifications/initialized") {
          socket = current
          if (publishInitial)
            current.send(JSON.stringify({ jsonrpc: "2.0", method: "selection_changed", params: selected }))
          if (!publishInitial) reconnected.resolve()
          connected.resolve()
        }
      },
    },
  })
  process.env.OPENCODE_EDITOR_SSE_PORT = String(server.port)
  const app = await createAppFixture({
    args: { sessionID },
    config: { animations: false, prompt: { editor: automatic } },
    fetch: async (url, request) => {
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}/inbox`) return json({ data: [] })
      if (url.pathname === "/api/agent") {
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      }
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model") {
        return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
      }
      if (url.pathname === "/api/fs/find") {
        const query = (url.searchParams.get("query") ?? "").replace(/^\.\//, "")
        return json({
          location,
          data: ["selection", "thisfile", "selection:notes", "Main.kt"]
            .filter((name) => name.includes(query))
            .map((name) => ({ path: name, type: "file" })),
        })
      }
      if (url.pathname === `/api/session/${sessionID}/synthetic`) {
        const body = await request.json()
        synthetic.push(body)
        return json({
          data: {
            id: body.id ?? "msg_ide_synthetic",
            sessionID,
            type: "synthetic",
            time: { created: 10 },
            payload: { text: body.text },
            delivery: "steer",
          },
        })
      }
      if (url.pathname === `/api/session/${sessionID}/prompt`) {
        const body = await request.json()
        submitted.resolve(body)
        return json({
          data: {
            id: body.id,
            sessionID,
            type: "user",
            time: { created: 10 },
            payload: { text: body.text, files: body.files },
            delivery: "steer",
          },
        })
      }
    },
  })
  await app.ready
  await connected.promise
  await app.waitForFrame((frame) => frame.includes("Demo Model") && (!automatic || frame.includes("Main.kt")))
  return {
    ...app,
    submitted: submitted.promise,
    synthetic,
    notify(value: unknown) {
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "selection_changed", params: value }))
    },
    disconnect() {
      socket.close()
    },
    disconnectWithoutFreshContext() {
      publishInitial = false
      socket.close()
      return reconnected.promise
    },
    async [Symbol.asyncDispose]() {
      await app[Symbol.asyncDispose]()
      await server.stop(true)
    },
  }
}

test("@selection snapshots unsaved text and does not also send implicit editor context", async () => {
  await using app = await fixture()
  await app.mockInput.typeText("@selection")
  await app.waitForFrame((frame) => frame.includes("IDE selection"))
  app.mockInput.pressEnter()
  await app.waitFor(() => app.renderer.currentFocusedEditor!.plainText.startsWith("@selection:"))
  app.notify({ ...selected, filePath: "/workspace/Other.kt", text: "different text" })
  await app.waitForFrame((frame) => frame.includes("Other.kt"))
  await app.mockInput.typeText("explain this")
  app.mockInput.pressEnter()
  const body = await app.submitted
  expect(body.files).toHaveLength(1)
  expect(body.files![0].uri).toStartWith("data:text/plain;base64,")
  const snapshot = Buffer.from(body.files![0].uri.split(",")[1], "base64").toString("utf8")
  expect(snapshot).toContain('println("UNSAVED λ")')
  expect(snapshot).toContain(`${directory}/Main.kt`)
  expect(snapshot).not.toContain("different text")
  expect(app.synthetic).toEqual([])
})

test("@thisfile follows a deselection update and attaches the saved file without a line range", async () => {
  await using app = await fixture()
  app.notify({
    filePath: "/workspace/with space/Other.kt",
    selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  })
  await app.waitForFrame((frame) => frame.includes("Other.kt"))
  await app.mockInput.typeText("@thisfile")
  await app.waitForFrame((frame) => frame.includes("saved file"))
  app.mockInput.pressEnter()
  await app.waitFor(() => app.renderer.currentFocusedEditor!.plainText.startsWith("@thisfile:"))
  await app.mockInput.typeText("review it")
  app.mockInput.pressEnter()
  const body = await app.submitted
  expect(body.files).toHaveLength(1)
  expect(body.files![0].uri).toBe("file:///workspace/with%20space/Other.kt")
  expect(app.synthetic).toEqual([])
})

test.each(["selection", "selection:notes"])(
  "explicit relative path %s is not treated as an IDE alias",
  async (name) => {
    await using app = await fixture()
    await app.mockInput.typeText(`@./${name}`)
    await app.waitForFrame((frame) =>
      frame.split("\n").some((line) => line.trimStart().startsWith("┃") && line.includes(name) && !line.includes("@")),
    )
    app.mockInput.pressEnter()
    await app.waitFor(() => app.renderer.currentFocusedEditor!.plainText === `@${name} `)
    await app.mockInput.typeText("read this file")
    app.mockInput.pressEnter()
    const body = await app.submitted
    expect(body.files).toHaveLength(1)
    expect(body.files![0].uri).toBe(`file:///tmp/opencode/packages/tui/${name}`)
    expect(app.synthetic).toHaveLength(1)
  },
)

test("removing a selection mention also removes its attachment", async () => {
  await using app = await fixture(false)
  await app.mockInput.typeText("@selection")
  await app.waitForFrame((frame) => frame.includes("IDE selection"))
  app.mockInput.pressEnter()
  await app.waitFor(() => app.renderer.currentFocusedEditor!.plainText.startsWith("@selection:"))
  app.mockInput.pressKey("u", { ctrl: true })
  await app.waitFor(() => app.renderer.currentFocusedEditor!.plainText === "")
  await app.mockInput.typeText("plain prompt")
  app.mockInput.pressEnter()
  const body = await app.submitted
  expect(body.files ?? []).toEqual([])
})

test("a disconnected IDE cannot attach a cached selection", async () => {
  await using app = await fixture(false)
  app.disconnect()
  await app.mockInput.typeText("@selection")
  await app.waitForFrame((frame) => frame.includes("No IDE connected"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("No IDE connected"))
  expect(app.renderer.currentFocusedEditor!.plainText).toBe("@selection")
})

test("a cleared selection reports an error rather than attaching the previous highlight", async () => {
  await using app = await fixture()
  app.notify({
    filePath: "/workspace/Other.kt",
    selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  })
  await app.waitForFrame((frame) => frame.includes("Other.kt"))
  await app.mockInput.typeText("@selection")
  await app.waitForFrame((frame) => frame.includes("IDE selection"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("No code is selected"))
  expect(app.renderer.currentFocusedEditor!.plainText).toBe("@selection")
})

test("an unavailable editor clears its cached path instead of attaching the last file", async () => {
  await using app = await fixture()
  app.notify({ filePath: null, text: null })
  await app.waitForFrame((frame) => !frame.includes("Main.kt"))
  await app.mockInput.typeText("@thisfile")
  await app.waitForFrame((frame) => frame.includes("saved file"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("No current IDE file"))
  expect(app.renderer.currentFocusedEditor!.plainText).toBe("@thisfile")
})

test("a reconnect without a fresh notification cannot revive the previous selection", async () => {
  await using app = await fixture(false)
  await app.mockInput.typeText("@selection")
  await app.waitForFrame((frame) => frame.includes("IDE selection"))
  await app.disconnectWithoutFreshContext()
  await app.waitForFrame((frame) => frame.includes("IDE selection"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("No current IDE file"))
  expect(app.renderer.currentFocusedEditor!.plainText).toBe("@selection")
})

test("automatic context does not submit a selection from a disconnected IDE", async () => {
  await using app = await fixture()
  await app.mockInput.typeText("@selection")
  await app.waitForFrame((frame) => frame.includes("IDE selection"))
  app.disconnect()
  await app.waitForFrame((frame) => frame.includes("No IDE connected"))
  app.mockInput.pressKey("u", { ctrl: true })
  await app.waitFor(() => app.renderer.currentFocusedEditor!.plainText === "")
  await app.mockInput.typeText("plain prompt")
  app.mockInput.pressEnter()
  await app.submitted
  expect(app.synthetic).toEqual([])
})

test.each(["selection", "thisfile"])("repeated @%s insertion retains only one removable attachment", async (kind) => {
  await using app = await fixture(false)
  for (let repeat = 0; repeat < 2; repeat++) {
    await app.mockInput.typeText(`@${kind}`)
    await app.waitForFrame((frame) => frame.includes(kind === "selection" ? "IDE selection" : "saved file"))
    app.mockInput.pressEnter()
    await app.waitFor(() => !app.renderer.currentFocusedEditor!.plainText.endsWith(`@${kind}`))
  }
  expect(app.renderer.currentFocusedEditor!.plainText.match(new RegExp(`@${kind}:`, "g"))).toHaveLength(1)
  app.mockInput.pressKey("u", { ctrl: true })
  await app.waitFor(() => app.renderer.currentFocusedEditor!.plainText === "")
  await app.mockInput.typeText("plain prompt")
  app.mockInput.pressEnter()
  const body = await app.submitted
  expect(body.files ?? []).toEqual([])
})

test("@thisfile upgrades an already attached file without adding unrelated implicit context", async () => {
  await using app = await fixture()
  await app.mockInput.typeText("@Main.kt")
  await app.waitForFrame((frame) =>
    frame
      .split("\n")
      .some((line) => line.trimStart().startsWith("┃") && line.includes("Main.kt") && !line.includes("@")),
  )
  app.mockInput.pressEnter()
  await app.waitFor(() => app.renderer.currentFocusedEditor!.plainText === "@Main.kt ")
  await app.mockInput.typeText("@thisfile")
  await app.waitForFrame((frame) => frame.includes("saved file"))
  app.mockInput.pressEnter()
  await app.waitFor(() => app.renderer.currentFocusedEditor!.plainText === "@Main.kt ")
  app.notify({ ...selected, filePath: "/workspace/Other.kt", text: "unrelated highlight" })
  await app.waitForFrame((frame) => frame.includes("Other.kt"))
  await app.mockInput.typeText("review the attached file")
  app.mockInput.pressEnter()
  const body = await app.submitted
  expect(body.files).toHaveLength(1)
  expect(body.files![0].uri).toBe(`file://${directory}/Main.kt`)
  expect(app.synthetic).toEqual([])
})
