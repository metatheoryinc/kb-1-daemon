export {
  emitVaultAudit,
  onVaultAudit,
  type AuditChangeEventOptions,
  type AuditEntry,
  type AuditInput,
  type VaultActor,
  type VaultAuditHandler,
} from "./audit.js";
export {
  INHERIT_COLOR,
  normalizeFolderMetadataColor,
  type FolderMetadataColor,
} from "./folder-metadata-options.js";
export {
  historyOperationFromAudit,
  listFileHistory,
  moveFileHistory,
  recordFileHistory,
  type FileHistoryEntry,
  type FileHistoryOperation,
  type FileHistoryPage,
  type ListFileHistoryInput,
  type MoveFileHistoryInput,
  type RecordFileHistoryInput,
} from "./file-history.js";
export { isNodeError, statOrNull } from "./fs.js";
export {
  InvalidPathError,
  resolveVaultPath,
  validateVaultPath,
} from "./path.js";
export {
  DOCUMENT_BYTES_LIMIT,
  SPLICE_BYTES_LIMIT,
  appendContent,
  applyAnchoredSplice,
  lfNormalize,
  prependContent,
  utf8ByteLength,
  type AnchoredSpliceRequest,
  type AnchoredSpliceResult,
} from "./splice.js";
export {
  searchVaultFiles,
  type SearchHit,
  type SearchInput,
  type SearchResult,
} from "./search.js";
export {
  classifyArtifactPath,
  deleteVaultFile,
  deleteVaultFolder,
  getFolderMetadata,
  getVaultInfo,
  listFolderMetadata,
  listVaultTree,
  makeVaultFolder,
  moveVaultPath,
  readVaultRawFile,
  readVaultFile,
  setFolderMetadata,
  writeVaultRawFile,
  writeVaultFile,
  type ArtifactInfo,
  type ArtifactKind,
  type ArtifactPreview,
  type DeleteValue,
  type FolderMetadata,
  type FolderMetadataInput,
  type FolderMetadataMap,
  type FolderMetadataValue,
  type MoveValue,
  type ReadFileValue,
  type ReadRawFileValue,
  type VaultContext,
  type VaultEntry,
  type VaultErrorCode,
  type VaultInfo,
  type VaultResult,
  type WriteFileValue,
  type WriteRawFileValue,
} from "./vault-ops.js";
export { anchoredSpliceContractCases } from "./splice-contract-cases.test-support.js";
