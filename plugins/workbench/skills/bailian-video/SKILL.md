---
name: bailian-video
description: Generate one short video from a text brief using the Bailian video tool.
---

# Bailian video generation

Turn the user's brief into one motion-aware video prompt with subject, action, scene and camera movement. Call `mcp__bailian-video__generate_video` once. The host runs this Skill's `generate.py`, stores the cloud task ID and saves the final MP4 locally. The tool may wait several minutes. Report the artifact ID and status returned by the tool; never invent a completed video, read an API key, or run shell commands.
