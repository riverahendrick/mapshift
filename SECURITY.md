# Security

Mapshift runs on your computer, reads your source code and edits your coding agents' settings, so security
reports are taken seriously.

## Reporting a problem

Please report security problems privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue for them. You will get a reply within a few days.

## What Mapshift promises

- No network calls of its own: no telemetry, no background update checks, nothing sent anywhere. The one
  exception is `mapshift update`, run by you, which asks npm for the newest version.
- Never reads, prints or copies login or credential files.
- Never starts a program from inside a project folder, and never follows links out of a project.
- A project's own git settings cannot make Mapshift run anything.
- Setup edits only personal settings, backs up every file first, and can be undone with `mapshift uninstall`.
- The dashboard listens only on `127.0.0.1`, behind a random address token, and stops when idle.

A break of any of these is a security bug.
