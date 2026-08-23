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
const stage = (name, detail) => {
  send(detail === undefined ? { out: 'stage', stage: name } : { out: 'stage', stage: name, detail })
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
  '        "tkinter": (',
  '            "tkinter cannot run in a browser - this sandbox offers turtle and"',
  '            " matplotlib for graphics instead"',
  '        ),',
  '        "_tkinter": "tkinter cannot run in a browser",',
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
  })
  pyodide.runPython(BOOT_PY)

  try {
    await pyodide.loadPackage(`${BASE}vendor/turtle-0.0.1-py3-none-any.whl`)
  } catch {
    pyodide.runPython(
      '_sandbox_block_module("turtle", "turtle is not bundled in this deployment")',
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
    await pyodide.loadPackagesFromImports(source)
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
