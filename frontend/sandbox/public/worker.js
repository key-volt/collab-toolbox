// The sandbox engine: Pyodide plus a Python console. An ES module, because this
// Pyodide generation ships as ESM (pyodide.mjs / pyodide.asm.mjs) and supports no
// classic-worker path. Normally it runs inside a blob module worker; where those are
// unavailable it runs on the sandbox page's own thread. Everything it can reach is
// decided by the page's CSP and the iframe sandbox attribute.

const IS_WORKER = typeof window === 'undefined'
const BASE = new URL('.', import.meta.url).href

const send = (message) => {
  if (IS_WORKER) self.postMessage(message)
  else window.__sandboxEngineReceive(message)
}
let stageName = 'starting'
const stage = (name, detail) => {
  stageName = name
  send(detail === undefined ? { out: 'stage', stage: name } : { out: 'stage', stage: name, detail })
}
// Progress rides on whatever stage is current, so a download shows up as
// "loading the interpreter (pyodide.asm.wasm — 12 MB)" without changing the stage.
const progress = (detail) => send({ out: 'stage', stage: stageName, detail })

// Downloads dominate boot (the interpreter is tens of MB) and first runs (every
// wheel an import pulls in), and a lossy connection can hang a fetch forever without
// ever failing it. Every same-origin GET therefore goes through this wrapper: the
// body is read chunk by chunk so progress reaches the stage line, a transfer that
// moves no bytes for STALL_MS aborts, and a failed transfer restarts from scratch a
// few times before the error — carrying the file's name — reaches the caller.
const STALL_MS = 20000
const TRANSFER_ATTEMPTS = 3
const nativeFetch = globalThis.fetch.bind(globalThis)

const transferOnce = async (url, name, init) => {
  const aborter = new AbortController()
  let timer = 0
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      aborter.abort(new Error('no data for 20 s'))
    }, STALL_MS)
  }
  try {
    arm()
    const response = await nativeFetch(url, { ...init, signal: aborter.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (response.body === null) return response
    const reader = response.body.getReader()
    const chunks = []
    let received = 0
    let reportedMb = 0
    for (;;) {
      arm()
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.length
      const mb = Math.floor(received / 1048576)
      if (mb > reportedMb) {
        reportedMb = mb
        progress(`${name} — ${mb} MB`)
      }
    }
    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    // A rebuilt Response: the browser decodes network bodies only, so the original
    // headers must not travel — just the content type, which WebAssembly's
    // streaming compile checks.
    return new Response(bytes, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('Content-Type') ?? '' },
    })
  } finally {
    clearTimeout(timer)
  }
}

globalThis.fetch = async (input, init) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  // Callers holding their own abort signal keep native semantics untouched.
  if (!url.startsWith(BASE) || method.toUpperCase() !== 'GET' || init?.signal !== undefined) {
    return nativeFetch(input, init)
  }
  const name = url.slice(BASE.length)
  let failure = 'failed'
  for (let attempt = 1; attempt <= TRANSFER_ATTEMPTS; attempt += 1) {
    try {
      return await transferOnce(url, name, init)
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause)
      if (attempt < TRANSFER_ATTEMPTS) {
        progress(`${name} — retrying (attempt ${attempt + 1} of ${TRANSFER_ATTEMPTS})`)
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
      }
    }
  }
  throw new Error(`${name}: ${failure}`)
}
const stdout = (text) => send({ out: 'stdout', text })
const stderr = (text) => send({ out: 'stderr', text })

// Python that prepares the interpreter: block what cannot exist in a browser with a
// clear message, route graphics out through the bridge, and hold the file tree the
// host hands over under /project.
const BOOT_PY = [
  'import base64',
  'import importlib.abc',
  'import io',
  'import json',
  'import os',
  'import shutil',
  'import sys',
  'import traceback',
  '',
  'import _sandbox_bridge',
  '',
  'os.environ.setdefault("MPLBACKEND", "Agg")',
  'os.makedirs("/project", exist_ok=True)',
  'os.chdir("/project")',
  'sys.path.insert(0, "/project")',
  '',
  '',
  'class _SandboxBlockedFinder(importlib.abc.MetaPathFinder):',
  '    blocked = {',
  '        "_tkinter": (',
  '            "the sandbox tkinter is a pure-Python emulation - _tkinter does"',
  '            " not exist here"',
  '        ),',
  '    }',
  '',
  '    def find_spec(self, fullname, path=None, target=None):',
  '        root = fullname.split(".")[0]',
  '        message = self.blocked.get(root)',
  '        if message is not None:',
  '            raise ModuleNotFoundError(message)',
  '        return None',
  '',
  '',
  '_sandbox_finder = _SandboxBlockedFinder()',
  'sys.meta_path.insert(0, _sandbox_finder)',
  '',
  '',
  'def _sandbox_block_module(name, message):',
  '    _sandbox_finder.blocked[name] = message',
  '',
  '',
  'class _SandboxBasthonKernel:',
  '    def display_event(self, data):',
  '        try:',
  '            if data.get("display_type") == "turtle":',
  '                _sandbox_bridge.emit_svg(json.dumps(data.get("content")))',
  '        except Exception:',
  '            pass',
  '',
  '',
  'class _SandboxBasthon:',
  '    kernel = _SandboxBasthonKernel()',
  '',
  '',
  'sys.modules.setdefault("basthon", _SandboxBasthon())',
  '',
  '',
  'def _sandbox_flush():',
  '    if "matplotlib.pyplot" in sys.modules:',
  '        plt = sys.modules["matplotlib.pyplot"]',
  '        try:',
  '            for number in plt.get_fignums():',
  '                buffer = io.BytesIO()',
  '                plt.figure(number).savefig(buffer, format="png")',
  '                _sandbox_bridge.emit_png(base64.b64encode(buffer.getvalue()).decode())',
  '            plt.close("all")',
  '        except Exception:',
  '            traceback.print_exc()',
  '    if "turtle" in sys.modules:',
  '        try:',
  '            scene = sys.modules["turtle"].Screen().show_scene()',
  '            if scene is not None:',
  '                _sandbox_bridge.emit_svg(json.dumps(scene))',
  '        except Exception:',
  '            pass',
  '    if "tkinter" in sys.modules:',
  '        try:',
  '            sys.modules["tkinter"]._flush()',
  '        except Exception:',
  '            pass',
  '',
  '',
  'def _sandbox_write_files(files_json):',
  '    entries = json.loads(files_json)',
  '    for name in os.listdir("/project"):',
  '        target = os.path.join("/project", name)',
  '        if os.path.isdir(target):',
  '            shutil.rmtree(target)',
  '        else:',
  '            os.unlink(target)',
  '    for entry in entries:',
  '        target = os.path.join("/project", entry["path"])',
  '        parent = os.path.dirname(target)',
  '        if parent:',
  '            os.makedirs(parent, exist_ok=True)',
  '        with open(target, "w", encoding="utf-8") as handle:',
  '            handle.write(entry["text"])',
  '',
  '',
  'def _sandbox_run(path):',
  '    source_path = os.path.join("/project", path)',
  '    namespace = {"__name__": "__main__", "__file__": source_path}',
  '    try:',
  '        with open(source_path, encoding="utf-8") as handle:',
  '            source = handle.read()',
  '        code = compile(source, path, "exec")',
  '        exec(code, namespace)',
  '    except EOFError:',
  '        print(',
  '            "input() is not supported while running a file in this sandbox -"',
  '            " use the interactive prompt instead.",',
  '            file=sys.stderr,',
  '        )',
  '    except SystemExit:',
  '        pass',
  '    except BaseException:',
  '        _, value, trace = sys.exc_info()',
  '        traceback.print_exception(value.with_traceback(trace.tb_next))',
  '    finally:',
  '        _sandbox_flush()',
].join('\n')

let pyodide = null
let pyconsole = null
let reprShorten = null
let awaitFut = null

// Mirrored verbatim from Pyodide's own console page: a console future must never be
// awaited directly — its proxy is consumed by the await, and reading formatted_error
// afterwards explodes with "Object has already been destroyed". The Python wrapper is
// what gets awaited; the future proxy stays readable and is destroyed explicitly.
const AWAIT_FUT_PY = [
  'import builtins',
  'from pyodide.ffi import to_js',
  '',
  '',
  'async def await_fut(fut):',
  '    res = await fut',
  '    if res is not None:',
  '        builtins._ = res',
  '    return to_js([res], depth=1)',
  '',
  '',
  'await_fut',
].join('\n')

const boot = async () => {
  stage('loading the interpreter')
  const { loadPyodide } = await import(`${BASE}pyodide/pyodide.mjs`)
  pyodide = await loadPyodide({
    indexURL: `${BASE}pyodide/`,
    // No interactive stdin: a script calling input() reaches end-of-file, and the
    // run wrapper explains the interactive prompt instead.
    stdin: () => null,
  })
  pyodide.setStdout({ batched: (text) => stdout(`${text}\n`) })
  pyodide.setStderr({ batched: (text) => stderr(`${text}\n`) })

  stage('preparing python')
  pyodide.registerJsModule('_sandbox_bridge', {
    emit_png: (data) => send({ out: 'png', data }),
    emit_svg: (data) => send({ out: 'svg', data }),
    emit_tk: (data) => send({ out: 'tk', data }),
  })
  pyodide.runPython(BOOT_PY)

  // The wheel is optional per deployment. Whether a failed load throws or is only
  // logged, what matters is whether the module ended up importable — Python itself is
  // asked, and a missing wheel becomes a clear message instead of a bare ImportError.
  // (This Pyodide generation ships no stdlib turtle, so the check is unambiguous.)
  try {
    await pyodide.loadPackage(`${BASE}vendor/turtle-0.0.1-py3-none-any.whl`)
  } catch {
    // the check below decides what this means
  }
  pyodide.runPython(
    [
      'import importlib.util',
      'if importlib.util.find_spec("turtle") is None:',
      '    _sandbox_block_module("turtle", "turtle is not bundled in this deployment")',
    ].join('\n'),
  )

  // The tkinter emulation is our own pure-Python module, served beside the turtle
  // wheel and written into the interpreter's path. A deployment missing the file
  // degrades to a clear message, never a bare ImportError.
  try {
    const shimResponse = await fetch(`${BASE}vendor/tkinter.py`)
    if (!shimResponse.ok) throw new Error(`HTTP ${String(shimResponse.status)}`)
    pyodide.FS.mkdirTree('/sandbox_lib')
    pyodide.FS.writeFile('/sandbox_lib/tkinter.py', await shimResponse.text())
    pyodide.runPython(
      [
        'import sys',
        'if "/sandbox_lib" not in sys.path:',
        '    sys.path.insert(1, "/sandbox_lib")',
      ].join('\n'),
    )
  } catch {
    pyodide.runPython(
      '_sandbox_block_module("tkinter", "the tkinter emulation is not bundled in this deployment")',
    )
  }

  const consoleModule = pyodide.pyimport('pyodide.console')
  const PyodideConsole = consoleModule.PyodideConsole
  reprShorten = consoleModule.repr_shorten
  pyconsole = PyodideConsole(pyodide.globals)
  pyconsole.stdout_callback = (text) => stdout(text)
  pyconsole.stderr_callback = (text) => stderr(text)
  awaitFut = pyodide.runPython(AWAIT_FUT_PY)

  stage('ready')
  send({ out: 'prompt', ps: 'primary' })
}

const readyPromise = boot().catch((cause) => {
  send({ out: 'fatal', text: cause instanceof Error ? cause.message : String(cause) })
  throw cause
})

const writeFiles = (files) => {
  pyodide.globals.set('_sandbox_io', JSON.stringify(files))
  pyodide.runPython('_sandbox_write_files(_sandbox_io)')
}

const flushGraphics = () => {
  pyodide.runPython('_sandbox_flush()')
}

// A DOM event from the rendered GUI: hand it to the emulation's dispatcher, which
// runs the Python callback and flushes whatever it changed.
const dispatchTkEvent = (event) => {
  pyodide.globals.set('_sandbox_tk_io', JSON.stringify(event))
  pyodide.runPython(
    [
      'import sys',
      'if "tkinter" in sys.modules:',
      '    sys.modules["tkinter"]._dispatch_event(_sandbox_tk_io)',
    ].join('\n'),
  )
}

const pushLine = async (line) => {
  const future = pyconsole.push(line)
  if (future.syntax_check === 'incomplete') {
    send({ out: 'prompt', ps: 'continuation' })
    future.destroy()
    return
  }
  if (future.syntax_check === 'syntax-error') {
    stderr(`${future.formatted_error}\n`)
    send({ out: 'prompt', ps: 'primary' })
    future.destroy()
    return
  }
  const wrapped = awaitFut(future)
  try {
    const [value] = await wrapped
    if (value !== undefined) {
      const shown = reprShorten.callKwargs(value, { separator: '\n<long output truncated>\n' })
      send({ out: 'result', text: String(shown) })
    }
    if (value instanceof pyodide.ffi.PyProxy) {
      value.destroy()
    }
  } catch (cause) {
    if (cause.constructor && cause.constructor.name === 'PythonError') {
      stderr(`${(future.formatted_error || cause.message).trimEnd()}\n`)
    } else {
      stderr(`${String(cause)}\n`)
    }
  } finally {
    future.destroy()
    wrapped.destroy()
    flushGraphics()
    send({ out: 'prompt', ps: 'primary' })
  }
}

const runJavascript = (source) => {
  const sandboxConsole = {
    log: (...parts) => stdout(`${parts.map(String).join(' ')}\n`),
    error: (...parts) => stderr(`${parts.map(String).join(' ')}\n`),
    warn: (...parts) => stdout(`${parts.map(String).join(' ')}\n`),
  }
  try {
    new Function('console', source)(sandboxConsole)
  } catch (cause) {
    stderr(`${String(cause)}\n`)
  }
}

const runFile = async (path, files) => {
  writeFiles(files)
  const entry = files.find((candidate) => candidate.path === path)
  const source = entry === undefined ? '' : entry.text
  if (path.endsWith('.js')) {
    runJavascript(source)
  } else {
    stage('loading packages')
    await pyodide.loadPackagesFromImports(source)
    stage('ready')
    const runner = pyodide.globals.get('_sandbox_run')
    try {
      runner(path)
    } finally {
      runner.destroy()
    }
  }
  send({ out: 'run-done' })
}

const handle = async (command) => {
  await readyPromise
  if (command.cmd === 'files') {
    writeFiles(command.files)
  } else if (command.cmd === 'push') {
    await pushLine(command.line)
  } else if (command.cmd === 'run') {
    await runFile(command.path, command.files)
  } else if (command.cmd === 'tk-event') {
    dispatchTkEvent(command.event)
  }
}

const queue = []
let pumping = false
const pump = async () => {
  if (pumping) return
  pumping = true
  while (queue.length > 0) {
    const command = queue.shift()
    try {
      await handle(command)
    } catch (cause) {
      stderr(`${String(cause)}\n`)
      if (command.cmd === 'run') send({ out: 'run-done' })
      else if (command.cmd === 'push') send({ out: 'prompt', ps: 'primary' })
    }
  }
  pumping = false
}
const enqueue = (command) => {
  queue.push(command)
  void pump()
}

if (IS_WORKER) {
  self.onmessage = (event) => enqueue(event.data)
} else {
  window.__sandboxEngineSend = (command) => enqueue(command)
}
