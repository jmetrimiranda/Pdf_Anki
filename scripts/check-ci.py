#!/usr/bin/env python3
"""Static checks of the GitHub workflows that the local suite can't otherwise see.

Inside a `bash -c '...'` block of a `run:` step, a single quote (an apostrophe in a comment, "OCR'd", "Anki's")
closes the string, and the step dies with a syntax error before running anything. That broke the Linux CI three
times. This finds such quotes and also checks that each `run:` script parses with `bash -n`.

    scripts/check-ci.py            exit 1 with file:line for every problem
"""
import pathlib
import re
import subprocess
import sys

import yaml  # PyYAML (host and CI runner have it)

ROOT = pathlib.Path(__file__).resolve().parent.parent
problems = []

for wf in sorted((ROOT / ".github" / "workflows").glob("*.yml")):
    doc = yaml.safe_load(wf.read_text())
    for job_name, job in (doc.get("jobs") or {}).items():
        for step in job.get("steps") or []:
            script = step.get("run")
            if not script:
                continue
            name = step.get("name", "?")
            # 1. bash -c '…' blocks: no single quote may appear between the opening quote and the closing `'` line.
            for m in re.finditer(r"bash (?:-o pipefail )?-c '\n(.*?)\n\s*'", script, re.S):
                for n, line in enumerate(m.group(1).splitlines(), 1):
                    if "'" in line:
                        problems.append(f"{wf.name} › {job_name} › {name}: aspa simples dentro de bash -c '…' "
                                        f"(linha {n} do bloco): {line.strip()}")
            # 2. The whole script must parse (what GitHub runs with `bash -e`). ${{ … }} expressions are opaque here.
            text = re.sub(r"\$\{\{.*?\}\}", "X", script)
            r = subprocess.run(["bash", "-n"], input=text, text=True, capture_output=True)
            if r.returncode != 0:
                problems.append(f"{wf.name} › {job_name} › {name}: bash -n: {r.stderr.strip()}")

if problems:
    print("check-ci: problemas nos workflows:")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print("check-ci: ok")
