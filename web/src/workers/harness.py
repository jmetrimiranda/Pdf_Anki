# The Python side of the Python code cards (docs/PROJETO.md 11.4), run by Pyodide inside python.worker.ts (and by
# the Node tests in harness.test.ts). One entry point, `leitor_run(request_json) -> result_json`:
#
#   request: {"mode": "testes" | "saida" | "estrutura", "code", "setup", "tests", "stdin", "expected"}
#   result:  {"mode", "tests", "stdout", "stderr", "error", "structure", "fallback", "importError"}
#
# - testes: a fresh namespace; Setup, then the user's code, then the Tests. Tests that define `test_*` functions
#   have each one called and reported; otherwise every top-level `assert` is a test, each one run in order and
#   reported (a failure with its line and, for `a == b`, both values), so "1 de 2" shows what still holds.
# - saida: sys.stdin is the Entrada; Setup + code run and stdout is captured (the comparison is done in TS).
# - estrutura: nothing runs; `ast.dump` of both programs without docstrings (comments are not in the AST), plus
#   `ast.unparse` of both for the side-by-side view.
# - an ImportError while running (e.g. `import rclpy`) falls back to estrutura (`fallback`, `importError`).
#
# The texts shown to the user are built in TS (pt-BR); this file returns data only. Timeouts are enforced by the
# main thread, which terminates the worker.
import ast
import io
import json
import sys
import traceback

OUTPUT_LIMIT = 64 * 1024
FILES = ("setup.py", "resposta.py", "testes.py")


class _Capture(io.TextIOBase):
    """A text stream that keeps at most OUTPUT_LIMIT characters (a print loop cannot exhaust the memory)."""

    def __init__(self):
        super().__init__()
        self._parts = []
        self._size = 0
        self.truncated = False

    def writable(self):
        return True

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError("write() argument must be str")
        room = OUTPUT_LIMIT - self._size
        if room > 0:
            part = s[:room]
            self._parts.append(part)
            self._size += len(part)
        if len(s) > room:
            self.truncated = True
        return len(s)

    def getvalue(self):
        return "".join(self._parts)


def _error_text(exc):
    """The exception with the traceback frames of the card's own files only (no harness frames)."""
    te = traceback.TracebackException.from_exception(exc)
    frames = [f for f in te.stack if f.filename in FILES]
    lines = []
    if frames:
        lines.append("Traceback (most recent call last):\n")
        lines.extend(traceback.StackSummary.from_list(frames).format())
    lines.extend(te.format_exception_only())
    return "".join(lines).rstrip()


def _is_import_error(exc):
    return isinstance(exc, ImportError)


def _without_docstrings(tree):
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = node.body
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                node.body = body[1:] or [ast.Pass()]
    return tree


def _structure_of(source):
    """(dump, unparsed source) of a program, or (None, error) when it does not parse."""
    try:
        tree = _without_docstrings(ast.parse(source))
    except SyntaxError as exc:
        return None, _error_text(exc)
    tree = ast.fix_missing_locations(tree)
    return ast.dump(tree), ast.unparse(tree)


def _structure(code, expected):
    want_dump, want_src = _structure_of(expected)
    got_dump, got_src = _structure_of(code)
    return {
        "same": want_dump is not None and got_dump is not None and want_dump == got_dump,
        "expectedDump": want_dump or "",
        "gotDump": got_dump or "",
        "expected": want_src,
        "got": got_src,
        "expectedParses": want_dump is not None,
        "gotParses": got_dump is not None,
    }


def _run_source(source, filename, ns):
    exec(compile(source, filename, "exec"), ns)


def _assert_values(node, ns):
    """For a failing `assert a == b`: repr of both sides (evaluated again), else (None, None)."""
    test = node.test
    if isinstance(test, ast.Compare) and len(test.ops) == 1 and isinstance(test.ops[0], ast.Eq):
        try:
            got = eval(compile(ast.Expression(test.left), "testes.py", "eval"), ns)
            want = eval(compile(ast.Expression(test.comparators[0]), "testes.py", "eval"), ns)
            return repr(got)[:500], repr(want)[:500]
        except Exception:
            return None, None
    return None, None


def _test_entry(name, ok, line=None, error=None, got=None, expected=None):
    return {"name": name, "ok": ok, "line": line, "error": error, "got": got, "expected": expected}


def _run_tests(tests, ns):
    """Runs the Tests in `ns` and returns the list of test entries."""
    tree = ast.parse(tests, "testes.py")
    lines = tests.splitlines()
    has_functions = any(
        isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith("test_") for n in tree.body
    )
    out = []
    if has_functions:
        _run_source(tests, "testes.py", ns)
        for node in tree.body:
            if not (isinstance(node, ast.FunctionDef) and node.name.startswith("test_")):
                continue
            fn = ns.get(node.name)
            if not callable(fn):
                continue
            try:
                fn()
                out.append(_test_entry(node.name, True, node.lineno))
            except Exception as exc:
                if _is_import_error(exc):
                    raise
                line = None
                tb = exc.__traceback__
                while tb is not None:
                    if tb.tb_frame.f_code.co_filename == "testes.py":
                        line = tb.tb_lineno
                    tb = tb.tb_next
                out.append(_test_entry(node.name, False, line, _error_text(exc)))
        return out
    # Top-level asserts: each one is a test, run in order; other statements just run.
    for node in tree.body:
        module = ast.Module(body=[node], type_ignores=[])
        code = compile(module, "testes.py", "exec")
        if not isinstance(node, ast.Assert):
            exec(code, ns)
            continue
        name = (lines[node.lineno - 1].strip() if node.lineno - 1 < len(lines) else "assert")[:200]
        try:
            exec(code, ns)
            out.append(_test_entry(name, True, node.lineno))
        except AssertionError as exc:
            got, want = _assert_values(node, ns)
            msg = str(exc) or None
            out.append(_test_entry(name, False, node.lineno, msg, got, want))
        except Exception as exc:
            if _is_import_error(exc):
                raise
            out.append(_test_entry(name, False, node.lineno, _error_text(exc)))
    return out


def _result(mode):
    return {
        "mode": mode,
        "tests": None,
        "stdout": "",
        "stderr": "",
        "error": None,
        "structure": None,
        "fallback": None,
        "importError": None,
        "errorStage": None,
        "truncated": False,
    }


def leitor_run(request_json):
    req = json.loads(request_json)
    mode = req.get("mode")
    code = req.get("code") or ""
    setup = req.get("setup") or ""
    tests = req.get("tests") or ""
    expected = req.get("expected") or ""
    out = _result(mode)

    if mode == "estrutura":
        out["structure"] = _structure(code, expected)
        return json.dumps(out)
    if mode not in ("testes", "saida"):
        out["error"] = f"unknown mode: {mode!r}"
        return json.dumps(out)

    stdout, stderr = _Capture(), _Capture()
    saved = sys.stdin, sys.stdout, sys.stderr
    sys.stdin = io.StringIO((req.get("stdin") or "") if mode == "saida" else "")
    sys.stdout, sys.stderr = stdout, stderr
    ns = {"__name__": "__main__", "__builtins__": __builtins__}
    stage = "setup.py"
    try:
        if setup.strip():
            _run_source(setup, "setup.py", ns)
        stage = "resposta.py"
        _run_source(code, "resposta.py", ns)
        if mode == "testes":
            stage = "testes.py"
            out["tests"] = _run_tests(tests, ns)
    except SystemExit:
        pass
    except BaseException as exc:
        if _is_import_error(exc):
            out["fallback"] = "estrutura"
            out["importError"] = str(exc)
            out["structure"] = _structure(code, expected)
        elif isinstance(exc, KeyboardInterrupt):
            raise
        else:
            out["error"] = _error_text(exc)
            out["errorStage"] = stage
    finally:
        sys.stdin, sys.stdout, sys.stderr = saved
    out["stdout"] = stdout.getvalue()
    out["stderr"] = stderr.getvalue()
    out["truncated"] = stdout.truncated or stderr.truncated
    return json.dumps(out)
