# MCP Parity Matrix

Every service-backed capability reachable from the local editor UI should have
an MCP equivalent or an explicit gap row in this matrix. The UI calls REST from
`apps/web`; MCP calls the same vault service boundary through
`packages/local-mcp`.

Vault discovery is explicit. REST callers use `GET /api/vaults`; MCP callers
use `list_vaults`. Every REST content route is scoped under
`/api/vaults/:id/...`, and every MCP data tool except `list_vaults` requires
`vaultId`. There is no implicit default vault on either surface.

| UI capability | REST route used by app | MCP parity tool | Gap |
| --- | --- | --- | --- |
| Discover/list vaults | `GET /api/vaults` | `list_vaults` | None |
| Create vault | `POST /api/vaults` | None | Open: no shipped MCP vault CRUD tools beyond listing. |
| Rename vault display name | `PUT /api/vaults/:id` | None | Open: no shipped MCP vault CRUD tools beyond listing. |
| Update vault metadata | `PUT /api/vaults/:id/metadata` | None | Open: no shipped MCP vault CRUD tools beyond listing. |
| Delete vault | `DELETE /api/vaults/:id` | None | Open: no shipped MCP vault CRUD tools beyond listing. |
| Read vault info | `GET /api/vaults/:id/vault` | `vault_info` | None |
| Read vault file tree with inline folder metadata | `GET /api/vaults/:id/tree` | `list_files` | None |
| Search notes with snippets, limit 50 | `GET /api/vaults/:id/search?q=...&limit=50` | `search` | None |
| Open/read a note for editing | Yjs socket route `/api/vaults/:id/files/{path}/yjs`; REST read available as `GET /api/vaults/:id/files/{path}` | `read_note` | None |
| Edit note content | Yjs socket route `/api/vaults/:id/files/{path}/yjs`; REST write available as `POST /api/vaults/:id/files/{path}/splice`, `append`, and `prepend` | `edit_note`; `append_note`; `prepend_note` | None |
| Create note from folder context menu | `PUT /api/vaults/:id/files/{path}` | `create_note` | None |
| Rename note from file context menu | `POST /api/vaults/:id/files/{path}/move` | `move_note` | None |
| Move note from file context menu | `POST /api/vaults/:id/files/{path}/move` | `move_note` | None |
| Delete note from file context menu | `DELETE /api/vaults/:id/files/{path}` | `delete_note` | None |
| Create folder from folder context menu | `POST /api/vaults/:id/folders` | `create_folder` | None |
| Rename folder from folder context menu | `POST /api/vaults/:id/folders/{path}/move` | `move_folder` | None |
| Move folder from folder context menu | `POST /api/vaults/:id/folders/{path}/move` | `move_folder` | None |
| Delete folder from folder context menu | `DELETE /api/vaults/:id/folders/{path}?recursive=true` | `delete_folder` | None |
| Read folder color/icon metadata | Inline in `GET /api/vaults/:id/tree`; direct `GET /api/vaults/:id/folders/{path}/metadata` | `get_folder_metadata`; `list_files` inline metadata | None |
| Set folder color from folder context menu | `PUT /api/vaults/:id/folders/{path}/metadata` | `set_folder_metadata` | None |
| List binary attachments | `GET /api/vaults/:id/tree` classification or `GET /api/vaults/:id/raw/{path}` once path is known | `list_attachments` | None |
| Read binary attachment | `GET /api/vaults/:id/raw/{path}` | `read_attachment` | None |
| Upload small binary attachment | `PUT /api/vaults/:id/raw/{path}` | `upload_attachment` | None |
| Read note history | `GET /api/vaults/:id/files/{path}/history` | None | Open: whether MCP parity requires a history tool is unresolved. |

App-local chrome has no service parity requirement when it never crosses the
vault service boundary. Favorites/starred rows are shipped UI state persisted in
the app-state store, not REST or MCP vault operations. Unshipped UI such as
presence, settings, icon-picker UI, folder canvas, mention autocomplete, and
pagination UI also has no parity requirement until it is reachable in the
product.
