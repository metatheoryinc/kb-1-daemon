import type { Meta, StoryObj } from "@storybook/svelte";
import FilesPanel from "./FilesPanel.svelte";
import { folderKey } from "./expansion";
import { localEditorTreeFixture } from "./fixtures";
import type { LocalTreeNode, VaultGroupData } from "./types";

const VAULT_ID = "demo-vault";

const meta = {
  title: "App/Local Editor/FilesPanel",
  component: FilesPanel,
  args: {
    vaultName: "demo-vault",
    vaultId: VAULT_ID,
    tree: localEditorTreeFixture,
    activePath: "projects/active/editor-shell.md",
    expandedFolderIds: new Set([
      folderKey(VAULT_ID, "projects"),
      folderKey(VAULT_ID, "projects/active"),
      folderKey(VAULT_ID, "research"),
    ]),
    hiddenVaultIds: [],
    onNewVault: () => {},
  },
} satisfies Meta<typeof FilesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Tree: Story = {};

export const VaultHidden: Story = {
  args: {
    hiddenVaultIds: [VAULT_ID],
  },
};

// A second vault to show the rail grouping more than one vault, each with
// its own tree, plus the working show/hide filter and the footer.
const SECOND_VAULT_ID = "field-notes";
const secondVaultTree: LocalTreeNode[] = [
  {
    kind: "folder",
    path: "daily",
    name: "daily",
    metadata: { color: "#ddd6fe" },
    children: [
      { kind: "file", path: "daily/2026-06-18.md", name: "2026-06-18.md" },
    ],
  },
  { kind: "file", path: "index.md", name: "index.md" },
];

const vaultGroups: VaultGroupData[] = [
  {
    id: VAULT_ID,
    name: "demo-vault",
    accent: "slate",
    tree: localEditorTreeFixture,
  },
  {
    id: SECOND_VAULT_ID,
    name: "field-notes",
    accent: "teal",
    tree: secondVaultTree,
  },
];

export const MultipleVaults: Story = {
  args: {
    vaultGroups,
    activeVaultIdForPath: VAULT_ID,
  },
};

export const SecondVaultHidden: Story = {
  args: {
    vaultGroups,
    activeVaultIdForPath: VAULT_ID,
    hiddenVaultIds: [SECOND_VAULT_ID],
  },
};
