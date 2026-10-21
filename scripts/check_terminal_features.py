#!/usr/bin/env python3
"""
Check the terminal features end to end: matplotlib, turtle, numpy/pandas, input(), C, C++, Java,
pip install, and the runaway-program limits. Joins the quiz as one "stresstest_" student.

  python scripts/check_terminal_features.py --access-code 2xGRMXwK
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import uuid
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stress_50_students import ws_session  # noqa: E402

MPL_SHOW = """\
import matplotlib.pyplot as plt
plt.plot([1, 2, 3], [4, 1, 9])
plt.title("test")
plt.show()
print("after show")
"""
MPL_SAVEFIG = """\
import matplotlib
import matplotlib.pyplot as plt
plt.bar(["a", "b"], [3, 5])
plt.savefig("chart.png")
print("saved")
"""
TURTLE = """\
import turtle
t = turtle.Turtle()
for _ in range(4):
    t.forward(100)
    t.left(90)
turtle.done()
"""
TURTLE_NO_DONE = """\
from turtle import *
color("red")
circle(50)
"""
NUMPY_PANDAS = """\
import numpy as np, pandas as pd
df = pd.DataFrame({"x": np.arange(5)})
print("sum", df.x.sum())
"""
INPUT_PY = 'n = input("Name: ")\nage = int(input("Age: "))\nprint(f"{n} is {age}")\n'
C_PROG = '#include <stdio.h>\nint main(){int a,b;printf("Two numbers: ");scanf("%d %d",&a,&b);printf("sum=%d\\n",a+b);return 0;}\n'
CPP_PROG = '#include <iostream>\n#include <vector>\nint main(){std::vector<int> v{1,2,3};int s=0;for(int x:v)s+=x;std::cout<<"cpp="<<s<<std::endl;}\n'
JAVA_PROG = ('import java.util.Scanner;\npublic class Main{public static void main(String[] a){'
             'Scanner s=new Scanner(System.in);System.out.print("Word: ");String w=s.nextLine();'
             'System.out.println("java="+w.toUpperCase());}}\n')
INFINITE = "while True:\n    pass\n"
SYNTAX_ERR = "print('missing paren'\n"


def case(name, language, filename, code, stdin=(), check=None, **extra):
    return dict(name=name, language=language, files=[{"filename": filename, "content": code}],
                entry=filename, stdin=list(stdin), check=check, extra=extra)


CASES = [
    case("matplotlib plt.show()", "python", "main.py", MPL_SHOW,
         check=lambda r: any(d.get("mime") == "image/png" for d in r["displays"]) and "after show" in r["output"]),
    case("matplotlib savefig", "python", "main.py", MPL_SAVEFIG,
         check=lambda r: "saved" in r["output"] and any(d.get("mime") == "image/png" for d in r["displays"])),
    case("turtle with done()", "python", "main.py", TURTLE,
         check=lambda r: any("svg" in str(d.get("mime")) for d in r["displays"])),
    case("turtle without done()", "python", "main.py", TURTLE_NO_DONE,
         check=lambda r: any("svg" in str(d.get("mime")) for d in r["displays"])),
    case("numpy + pandas", "python", "main.py", NUMPY_PANDAS, check=lambda r: "sum 10" in r["output"]),
    case("python input()", "python", "main.py", INPUT_PY, ["Ana\n", "20\n"],
         check=lambda r: "Ana is 20" in r["output"]),
    case("C scanf", "c", "main.c", C_PROG, ["3 4\n"], check=lambda r: "sum=7" in r["output"]),
    case("C++", "cpp", "main.cpp", CPP_PROG, check=lambda r: "cpp=6" in r["output"]),
    case("Java Scanner", "java", "Main.java", JAVA_PROG, ["hello\n"], check=lambda r: "java=HELLO" in r["output"]),
    case("syntax error shown", "python", "main.py", SYNTAX_ERR,
         check=lambda r: "SyntaxError" in r["output"] and (r["exit"] or {}).get("exit_code") != 0),
    case("infinite loop is stopped", "python", "main.py", INFINITE,
         check=lambda r: r["exit"] is not None and (r["exit"] or {}).get("exit_code") != 0),
]


async def run_case(base: str, sid: str, c: dict) -> dict:
    start = {"session_id": sid, "language": c["language"], "files": c["files"], "entry": c["entry"], **c["extra"]}
    return await ws_session(base, start, c["stdin"], 120)


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--access-code", required=True)
    args = ap.parse_args()
    base = args.base_url.rstrip("/")

    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.post(f"{base}/quiz/join", json={"access_code": args.access_code,
                                                          "user_id": f"stresstest_feat_{uuid.uuid4().hex[:6]}",
                                                          "programming_language": "python"})
        r.raise_for_status()
        sid = r.json()["session_id"]

    failures = 0
    for c in CASES:
        try:
            res = await run_case(base, sid, c)
            ok = bool(c["check"](res))
            detail = f"exit={(res['exit'] or {}).get('exit_code')} reason={(res['exit'] or {}).get('reason')!r} " \
                     f"images={[d.get('mime') for d in res['displays']]}"
            if not ok:
                detail += f" rejected={res['rejected']!r} out={res['output'][-300:]!r}"
        except Exception as e:
            ok, detail = False, f"{type(e).__name__}: {e}"
        failures += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {c['name']:<26} {detail}")

    # pip install a small package and import it
    pip = await ws_session(base, {"session_id": sid, "language": "python", "files": [], "action": "pip",
                                  "args": ["install", "tabulate"]}, [], 300)
    run = await ws_session(base, {"session_id": sid, "language": "python", "entry": "main.py", "files": [
        {"filename": "main.py", "content": "from tabulate import tabulate\nprint(tabulate([[1,2]]))"}]}, [], 60)
    ok = (pip["exit"] or {}).get("exit_code") == 0 and (run["exit"] or {}).get("exit_code") == 0
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'}  {'pip install + import':<26} {pip['output'][-120:]!r}")
    print(f"\n{len(CASES) + 1 - failures}/{len(CASES) + 1} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
