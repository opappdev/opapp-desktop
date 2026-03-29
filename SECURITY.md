# Security Policy

## Supported branch

Security fixes are handled on `main`.

## Reporting a vulnerability

Please do not open a public issue with undisclosed exploit details.

Use GitHub's private vulnerability reporting or security advisory workflow when
it is available for this repository. If private reporting is temporarily
unavailable, open a minimal public issue that only requests a private contact
channel and do not include reproduction details, credentials, or payloads.

## What to include

- Affected commit, branch, or packaged build if known.
- Clear reproduction steps and expected impact.
- Whether the issue affects dev, packaged, portable, or OTA flows.
- Any mitigation or workaround you already tested.

## What not to post publicly

- `R2_*` credentials or any `.env` file contents.
- `%TEMP%\\opapp-windows-host.launch.ini` contents if they expose local paths or overrides you do not want published.
- `.ota-cache`, `.artifact-registry`, or device-specific identifiers copied verbatim from your machine.
- Private smoke or verify extension contents.

## Disclosure expectations

Please allow maintainers time to validate, patch, and coordinate disclosure
before publishing exploit details or proof-of-concept code.
