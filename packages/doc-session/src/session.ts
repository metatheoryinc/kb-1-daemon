import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import * as Y from 'yjs';

export const DEFAULT_DEMO_DOCUMENT_CONTENT = [
  '# Hello KB-2',
  '',
  'This Markdown file is served by the local KB-2 daemon.',
  ''
].join('\n');

const Y_TEXT_NAME = 'markdown';

export interface DocumentSessionWarning {
  type: 'external-change-detected';
  filePath: string;
  expectedHash: string;
  actualHash: string | undefined;
}

export interface OneFileDocumentSessionOptions {
  defaultContent?: string;
  warn?: (warning: DocumentSessionWarning) => void;
}

export class OneFileDocumentSession {
  readonly filePath: string;

  private readonly defaultContent: string;
  private readonly warn: (warning: DocumentSessionWarning) => void;
  private readonly doc = new Y.Doc();
  private readonly text = this.doc.getText(Y_TEXT_NAME);
  private opened = false;
  private openPromise: Promise<void> | undefined;
  private lastWrittenHash: string | undefined;
  private persistRequested = false;
  private persistPromise: Promise<void> | undefined;

  constructor(filePath: string, options: OneFileDocumentSessionOptions = {}) {
    this.filePath = filePath;
    this.defaultContent = options.defaultContent ?? DEFAULT_DEMO_DOCUMENT_CONTENT;
    this.warn = options.warn ?? ((warning) => {
      console.warn(`KB-2 external document change detected at ${warning.filePath}; preserving active Yjs session state.`);
    });
  }

  get ydoc(): Y.Doc {
    return this.doc;
  }

  async open(): Promise<void> {
    if (this.opened) {
      return;
    }

    if (!this.openPromise) {
      this.openPromise = this.loadFromFile().finally(() => {
        this.openPromise = undefined;
      });
    }

    await this.openPromise;
  }

  private async loadFromFile(): Promise<void> {
    const content = await this.readOrCreateFile();
    this.text.insert(0, content);
    this.lastWrittenHash = hashContent(content);
    this.doc.on('update', this.handleDocumentUpdate);
    this.opened = true;
  }

  async getContent(): Promise<string> {
    await this.open();
    return this.currentContent();
  }

  async reset(content = this.defaultContent): Promise<string> {
    await this.open();

    this.doc.transact(() => {
      this.text.delete(0, this.text.length);
      this.text.insert(0, content);
    }, this);

    await this.flush();
    return this.currentContent();
  }

  async flush(): Promise<void> {
    if (this.persistPromise) {
      await this.persistPromise;
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.doc.off('update', this.handleDocumentUpdate);
  }

  private readonly handleDocumentUpdate = (): void => {
    void this.requestPersist();
  };

  private requestPersist(): Promise<void> {
    this.persistRequested = true;

    if (!this.persistPromise) {
      this.persistPromise = this.persistLoop().finally(() => {
        this.persistPromise = undefined;
      });
    }

    return this.persistPromise;
  }

  private async persistLoop(): Promise<void> {
    while (this.persistRequested) {
      this.persistRequested = false;
      await this.materialize();
    }
  }

  private async materialize(): Promise<void> {
    const content = this.currentContent();
    const diskContent = await readOptionalFile(this.filePath);
    const diskHash = diskContent === undefined ? undefined : hashContent(diskContent);

    if (this.lastWrittenHash !== undefined && diskHash !== this.lastWrittenHash) {
      this.warn({
        type: 'external-change-detected',
        filePath: this.filePath,
        expectedHash: this.lastWrittenHash,
        actualHash: diskHash
      });
    }

    await atomicWriteFile(this.filePath, content);
    this.lastWrittenHash = hashContent(content);
  }

  private async readOrCreateFile(): Promise<string> {
    const existing = await readOptionalFile(this.filePath);
    if (existing !== undefined) {
      return existing;
    }

    await atomicWriteFile(this.filePath, this.defaultContent);
    return this.defaultContent;
  }

  private currentContent(): string {
    return this.text.toString();
  }
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });

  const temporaryPath = join(directory, `.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
