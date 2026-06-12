# MCP Parity Matrix

Every vault capability reachable from the local editor UI must have an MCP tool
equivalent. The UI calls REST from `apps/web`; MCP calls the same vault service
boundary through `packages/local-mcp`.

| UI capability | REST route used by app | MCP parity tool | Gap |
| --- | --- | --- | --- |
| Read vault file tree with inline folder metadata | `GET /api/tree` | `list_files` | None |
| Search notes with snippets, limit 50 | `GET /api/search?q=...&limit=50` | `search` | None |
| Open/read a note for editing | Yjs session route `GET /api/files/{path}/yjs`; REST read available as `GET /api/files/{path}` | `read_note` | None |
| Create note from folder context menu | `PUT /api/files/{path}` | `create_note` | None |
| Rename note from file context menu | `POST /api/files/{path}/move` | `move_note` | None |
| Move note from file context menu | `POST /api/files/{path}/move` | `move_note` | None |
| Delete note from file context menu | `DELETE /api/files/{path}` | `delete_note` | None |
| Create folder from folder context menu | `POST /api/folders` | `create_folder` | None |
| Rename folder from folder context menu | `POST /api/folders/{path}/move` | `move_folder` | None |
| Move folder from folder context menu | `POST /api/folders/{path}/move` | `move_folder` | None |
| Delete folder from folder context menu | `DELETE /api/folders/{path}?recursive=true` | `delete_folder` | None |
| Read folder color/icon metadata | Inline in `GET /api/tree`; direct `GET /api/folders/{path}/metadata` | `get_folder_metadata`; `list_files` inline metadata | None |
| Set folder color from folder context menu | `PUT /api/folders/{path}/metadata` | `set_folder_metadata` | None |

Out-of-scope UI in Chunk 011B has no parity requirement because it is not
reachable in the product: favorites, history, presence, settings, icon-picker
UI, folder canvas, mention autocomplete, image upload, and pagination UI.
