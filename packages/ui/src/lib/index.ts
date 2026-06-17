export { default as Button, buttonVariants } from './button/button.svelte';
export type { ButtonProps, ButtonSize, ButtonVariant } from './button/button.svelte';
export { default as Badge } from './primitives/Badge.svelte';
export { default as Avatar } from './primitives/Avatar.svelte';
export { default as BrandMark } from './primitives/BrandMark.svelte';
export { default as Breadcrumb } from './primitives/Breadcrumb.svelte';
export type { BreadcrumbAvatar, BreadcrumbItem } from './primitives/Breadcrumb.svelte';
export { default as Checkbox } from './primitives/Checkbox.svelte';
export { default as FolderIcon } from './primitives/FolderIcon.svelte';
export { default as Icon } from './primitives/Icon.svelte';
export { default as IconButton } from './primitives/IconButton.svelte';
export { default as LiveDot } from './primitives/LiveDot.svelte';
export { default as LiveStatusChip } from './primitives/LiveStatusChip.svelte';
export { default as SearchInput } from './primitives/SearchInput.svelte';
export { default as FormField } from './primitives/forms/FormField.svelte';
export { default as FormSelect } from './primitives/forms/FormSelect.svelte';
export type { FormSelectOption } from './primitives/forms/FormSelect.svelte';
export { default as ContextMenu } from './menus/ContextMenu.svelte';
export type { MenuItem } from './menus/ContextMenu.svelte';
export { default as Popover } from './menus/Popover.svelte';
export { default as DialogShell } from './dialogs/DialogShell.svelte';
export { default as Panel } from './layout/Panel.svelte';
export { default as LocalStatusShell } from './layout/LocalStatusShell.svelte';
export type { DaemonStatus, HealthResponse } from './layout/LocalStatusShell.svelte';
export { default as DocumentSaveBanner } from './notifications/DocumentSaveBanner.svelte';
export { default as DocumentHeader } from './local-editor/DocumentHeader.svelte';
export { default as EditorSaveNotifications } from './local-editor/EditorSaveNotifications.svelte';
export { default as DocumentNotFoundState } from './local-editor/DocumentNotFoundState.svelte';
export { default as FileNode } from './local-editor/FileNode.svelte';
export { default as FilesPanel } from './local-editor/FilesPanel.svelte';
export { default as FilesSearchResults } from './local-editor/FilesSearchResults.svelte';
export { default as FolderNode } from './local-editor/FolderNode.svelte';
export { default as LocalEditorShell } from './local-editor/LocalEditorShell.svelte';
export { default as StarredPanel } from './local-editor/StarredPanel.svelte';
export { default as PrimaryRail, type RailNavId } from './local-editor/primary-rail/PrimaryRail.svelte';
export { default as PrimaryRailItem } from './local-editor/primary-rail/PrimaryRailItem.svelte';
export { default as PrimaryRailUserChip } from './local-editor/primary-rail/PrimaryRailUserChip.svelte';
export type {
  LocalFileAction,
  LocalFileNode,
  LocalFolderAction,
  LocalFolderMetadata,
  LocalFolderNode,
  LocalSearchResult,
  LocalTreeAction,
  LocalTreeNode,
} from './local-editor/types';
export type {
  DocumentSaveBannerProps,
  DocumentSaveBannerVariant,
} from './notifications/DocumentSaveBanner.svelte';
export type { EditorSaveNotificationsProps } from './local-editor/EditorSaveNotifications.svelte';
export type {
  EditorSaveNotificationCopy,
  EditorSaveNotificationFlags,
  EditorSaveNotificationsCopy,
  EditorSaveNotificationVariant,
} from './local-editor/editor-save-notifications';
export {
  accentForId,
  accentHex,
  accentHexForId,
  accentNames,
  accentStyle,
  accents,
  type AccentName,
} from './primitives/accent';
export { iconNames, type IconName, type IconWeight } from './primitives/types';
