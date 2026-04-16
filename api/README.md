# Compliance API

This package is the control-plane scaffold for the broader compliance platform.

Its current purpose is to give the monorepo a stable home for the future central API described in the worker docs:

- job orchestration,
- worker sync endpoints,
- metadata coordination,
- and certificate generation.

For now it exposes a minimal Bun server so the package can be developed and typechecked inside the workspace without inventing the full API contract prematurely.
