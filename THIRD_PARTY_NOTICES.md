# Third-party notices

Video Quickly original code is provided under the root MIT license.

## Interface skill

- Source: https://github.com/lazyseacow/make-interfaces-feel-better
- Original upstream: https://github.com/jakubkrehel/make-interfaces-feel-better
- License: MIT; retained at `.agents/skills/make-interfaces-feel-better/LICENSE`.
- Imported revision and source path: `.agents/skills/make-interfaces-feel-better/source.json`.

## Runtime and UI dependencies

React, React Flow, Lucide, Zod, LangGraph.js, Deep Agents, Motion Canvas, better-sqlite3 and Tauri retain their respective package licenses. Dependency versions are recorded in `pnpm-lock.yaml` and the native Cargo lock file when built.

GSAP and `@gsap/react` are distributed under the [GSAP Standard License](https://gsap.com/standard-license/). Their upstream README files, including copyright notices and license links, accompany the desktop distribution. These package licenses are separate from the MIT license of the authoring skills below.

## GSAP authoring skills

- Source: https://github.com/greensock/gsap-skills
- Revision: `aed9cfd3277740755f6bfc1155c7aa645403b760`.
- Skills: `gsap-core`, `gsap-react`, `gsap-timeline`, `gsap-performance`.
- License: MIT; retained in each imported `.agents/skills/gsap-*/LICENSE`.
- Imported source and revision are recorded in each skill's `source.json`.

## Media tools

FFmpeg and FFprobe run as external executables. Their exact build, source, checksum and license must accompany a distributed tools package. Development downloads and generated media are not committed.

## Workflow references

- https://github.com/lazyseacow/gen-history-video — workflow concepts; built-in template independently authored.
- User-provided video-generator repository — architecture and behavioral reference.
- Kdenlive manual (https://docs.kdenlive.org/en/user_interface/timeline.html) and Shotcut user guide (https://forum.shotcut.org/t/user-guide-table-of-contents/43285) — timeline layout references; implementation independently authored.

Bundled example drawings are original project assets. Their historical appearance is illustrative reconstruction; source verification remains a separate project step.
