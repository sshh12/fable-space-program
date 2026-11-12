"""Config-driven tile bake for the simple bodies (ARCHITECTURE 8.5): one driver, one JSON per body under
tools/bake/planet/bodies/, no per-body code.

Run:     python -I tools/bake/planet/bake.py <body id> | --all   (through tools/dev/heavy.mjs --class=bake)
Verify:  python -I tools/bake/planet/verify.py --all
"""
