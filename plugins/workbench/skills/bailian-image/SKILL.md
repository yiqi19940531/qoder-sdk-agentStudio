---
name: bailian-image
description: Generate one image from a text brief using the Bailian image tool.
---

# Bailian image generation

Turn the user's brief into one precise image prompt. Call `mcp__bailian-image__generate_image` once. The host runs this Skill's `generate.py` with a protected credential and saves the result locally. Return the artifact ID and describe the result only after the tool reports success. Never ask for or print an API key, run a shell command, or invent an image URL.
