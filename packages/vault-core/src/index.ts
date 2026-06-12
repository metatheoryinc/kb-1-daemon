export {
  emitVaultAudit,
  onVaultAudit,
  type AuditChangeEventOptions,
  type AuditEntry,
  type AuditInput,
  type VaultActor,
  type VaultAuditHandler
} from './audit.js';
export {
  folderMetadataColorNames,
  folderMetadataIconNames,
  type FolderMetadataColor,
  type FolderMetadataIcon
} from './folder-metadata-options.js';
export { isNodeError, statOrNull } from './fs.js';
export { InvalidPathError, resolveVaultPath, validateVaultPath } from './path.js';
export {
  DOCUMENT_BYTES_LIMIT,
  SPLICE_BYTES_LIMIT,
  appendContent,
  applyAnchoredSplice,
  lfNormalize,
  prependContent,
  utf8ByteLength,
  type AnchoredSpliceRequest,
  type AnchoredSpliceResult
} from './splice.js';
export {
  searchVaultFiles,
  type SearchHit,
  type SearchInput,
  type SearchResult
} from './search.js';
export {
  deleteVaultFile,
  deleteVaultFolder,
  getFolderMetadata,
  getVaultInfo,
  listFolderMetadata,
  listVaultTree,
  makeVaultFolder,
  moveVaultPath,
  readVaultFile,
  setFolderMetadata,
  writeVaultFile,
  type DeleteValue,
  type FolderMetadata,
  type FolderMetadataInput,
  type FolderMetadataMap,
  type FolderMetadataValue,
  type MoveValue,
  type ReadFileValue,
  type VaultContext,
  type VaultEntry,
  type VaultErrorCode,
  type VaultInfo,
  type VaultResult,
  type WriteFileValue
} from './vault-ops.js';
export { anchoredSpliceContractCases } from './splice-contract-cases.test-support.js';
