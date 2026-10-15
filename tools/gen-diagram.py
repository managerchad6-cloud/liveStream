"""
Ask Gemini 2.5 Flash to write matplotlib diagram code, then execute it.
"""
from google import genai
import os, re, subprocess, sys, textwrap

API_KEY  = os.environ['GEMINI_API_KEY']   # was hardcoded on the server; rotate that key
OUT_PNG  = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'yt-reaction-diagram.png'))
CODE_TMP = os.path.join(os.path.dirname(__file__), '_diagram_code.py')

PROMPT = f"""
Write a complete, self-contained Python script using matplotlib that produces a
SINGLE PNG saved to exactly this path (hardcoded string):
  {OUT_PNG}

The diagram title is: "YouTube Reaction Mode — Timing Bug & Fix"
figsize=(20, 12), dpi=150, white background, tight_layout.

The figure has TWO rows of subplots, each row sharing an x-axis (time in seconds, 0-140s).
Top row title: "❌  CURRENT BEHAVIOUR (broken)"  — use a light red (#fff0f0) background
Bottom row title: "✅  FIXED BEHAVIOUR"           — use a light green (#f0fff0) background

Each row contains 3 stacked horizontal tracks (use broken_barh or axhlines):

--- TRACK 1: "TV Video" ---
BROKEN row:
  - Green bar from 0→42s  (label "playing")
  - Red bar 42→59s        (label "PAUSED beat 0")
  - Green bar 59→75s      (label "playing")  ← but video is at pos 57.5s not 75s
  - Red bar 75→93s        (label "PAUSED beat 1")
  - Green bar 93→110s     (label "playing")  ← video is even further behind
  - Red bar 110→128s      (label "PAUSED beat 2")
  Draw a horizontal double-arrow below the track at x=75→93 labeled "cumulative drift"
  with annotation showing ⚠ TV is at 57.5s not 75s

FIXED row:
  - Green bars with pauses at exact video positions 42s, 75s, 110s
  - No drift; pauses are clean and same width

--- TRACK 2: "Beat Timers" ---
BROKEN row:
  - Three vertical dashed red lines at x=42, 75, 110
  - Label each "timer fires" at top
  - Add a second set of vertical dotted orange lines at 59, 93, 128 (resume timers)
  - Label "resume (est.)"
  - Show with a red annotation: "ALL armed at T0, no drift correction"

FIXED row:
  - Same vertical green lines at 42, 75, 110 labeled "timer fires"
  - Green dotted lines for resume at 59, 93, 128 labeled "resume (audio end + 1s)"
  - Annotation: "timers re-armed after each resume"

--- TRACK 3: "Viewer Experience" ---
BROKEN row — colored horizontal segments:
  x=0-10:   light blue   "intro overlaps TV start"
  x=10-42:  green        "video OK"
  x=42-59:  orange       "reaction (correct)"
  x=59-75:  yellow       "silence gap"
  x=75-93:  red          "character speaks BEFORE pause visible (drift)"
  x=93-110: dark red     "long silence"
  x=110-128: darkred     "very early, very long silence"

FIXED row — colored segments:
  x=0-10:   light green  "intro, then video starts"
  x=10-42:  green        "video plays"
  x=42-59:  dodgerblue   "beat 0: clean reaction"
  x=59-75:  green        "video resumes"
  x=75-93:  dodgerblue   "beat 1: clean reaction"
  x=93-110: green        "video resumes"
  x=110-128: dodgerblue  "beat 2: clean reaction"
  x=128-140: green       "wrapup, TV cleared"

Add a text box at the bottom of the figure listing the 4 fixes:
  "FIXES NEEDED:
   1. Start TV after intro finishes (on intro completion), not at intro on-air
   2. Re-arm each beat timer as: remaining_video_time = beat.pause_at - accumulated_pause_time
   3. Resume video only after actual audio playback ends (not word-count estimate)
   4. Clear TV playlist on session end"

Use clean sans-serif fonts. Add a legend for track colors.
Add x-axis label "Time (seconds from session start)".
y-axis labels for each track name.
Make all text readable at normal screen size.

Return ONLY the Python code, no markdown fences, no explanation.
"""

def main():
    print("Asking Gemini 2.5 Flash to write the diagram code…")
    client = genai.Client(api_key=API_KEY)
    resp = client.models.generate_content(
        model='gemini-2.5-flash',
        contents=PROMPT,
    )
    code = resp.text.strip()

    # Strip markdown fences if model added them
    code = re.sub(r'^```python\s*', '', code, flags=re.MULTILINE)
    code = re.sub(r'^```\s*$', '', code, flags=re.MULTILINE)

    with open(CODE_TMP, 'w', encoding='utf-8') as f:
        f.write(code)
    print(f"Code written to {CODE_TMP} ({len(code)} chars) — executing…")

    result = subprocess.run([sys.executable, CODE_TMP], capture_output=True, text=True)
    if result.returncode != 0:
        print("STDERR:", result.stderr[-3000:])
        print("STDOUT:", result.stdout[-1000:])
        sys.exit(1)

    print(f"Done → {OUT_PNG}")
    if result.stdout:
        print(result.stdout)

if __name__ == '__main__':
    main()
