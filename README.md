# Monster Island

Prototypes of **Island Humans and Monsters**, a real-time sandbox in which a village and six monsters share an
island, and each midnight a god (Claude) writes a new gameplay module that permanently changes the world.

## Layout

| Folder | What it is |
|---|---|
| [`design/`](design/) | The game design doc: the source every prototype was built from |
| [`prototypes/monster-island/`](prototypes/monster-island/) | The first prototype: a blocky god-game island that proved out Claude writing live gameplay modules |
| [`prototypes/top-down/`](prototypes/top-down/) | *Island Humans and Monsters*, top-down, for mobile (touch) |
| [`prototypes/first-person/`](prototypes/first-person/) | *Island Humans and Monsters*, first person, for desktop (mouse and keyboard) |

Each prototype is a self-contained project with its own README, `docs/` (the tech spec it was built from, plus a
snapshot of the design doc at the time) and tests. Copied code is expected: `first-person` started as a copy of
`top-down`, which started from `monster-island`.

## Running a prototype

You need [Node.js](https://nodejs.org/) 20 or newer.

```bash
cd prototypes/first-person     # or top-down, monster-island
npm install
npm run dev                    # open the URL it prints
npm test
```

The midnight god calls the [Claude Code](https://claude.com/claude-code) CLI (`claude -p`) through the dev server.
Install it and log in to get a real god; without it, the game falls back to a manual god.

On Windows, keep the clone on the WSL (Linux) filesystem, not under `C:\`: Vite's file watching and `npm install`
are much slower across the Windows mount.

## Browsing the files from Windows (WSL)

Windows can open WSL files at `\\wsl.localhost\<distro>\home\<you>` (e.g. `\\wsl.localhost\Ubuntu\home\jeffr`),
or through **Linux** at the bottom of File Explorer's sidebar. On some machines Explorer shows the folder for an instant
and then jumps back to `C:\`. The fix is to map WSL to a drive letter, which Explorer treats like any other drive.

1. Find your distro's name: in PowerShell, run `wsl -l -v` (usually `Ubuntu`).
2. Map it to a free letter, here `W:` (in PowerShell or a Command Prompt, not as administrator):

   ```
   net use W: \\wsl.localhost\Ubuntu /persistent:yes
   ```

   On older Windows 10 builds, use `\\wsl$\Ubuntu` instead.
3. Open **This PC → W:**, then `home\<your Linux user>\monster-island`. Right-click the folder → **Pin to Quick access**.

The drive only works while WSL is running. If `W:` shows a red X after a reboot, open an Ubuntu terminal once, then
click the drive again. From inside WSL, `explorer.exe .` opens Explorer on the current folder. To remove the mapping:
`net use W: /delete`.

Editing the files from Windows is fine, but run `npm`, `git` and the dev server inside WSL. VS Code works best
connected to WSL: run `code .` from an Ubuntu terminal in the project folder.

## History

This repository started as the original `monster-island` prototype alone. Its earlier history is under `prototypes/monster-island/`;
the other two prototypes were merged in with their full commit history.
