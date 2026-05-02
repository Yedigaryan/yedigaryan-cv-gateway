# gateway/ — Docker build context

This folder is what Render copies into the container image (the
`rootDir: gateway` setting in the top-level [`../render.yaml`](../render.yaml)
scopes the build context to here, so the rest of the repo's docs / plist
templates don't ship into the image).

For the architecture overview, env-var contract, and the runbook, see
the **top-level [`../README.md`](../README.md)** and
**[`../DEPLOY.md`](../DEPLOY.md)**.

The `.dockerignore` strips Markdown so this README never enters the image.
