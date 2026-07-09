import {
  EditorView,
  ViewPlugin,
  keymap,
  type PluginValue,
  type ViewUpdate,
} from '@codemirror/view';
import { Prec, type Extension } from '@codemirror/state';
import { mount, unmount } from 'svelte';
import type { OrgPerson } from './markdown-core';
import MentionAutocompletePopover from './MentionAutocompletePopover.svelte';
import {
  filterPeople,
  formatMentionInsertion,
  getQueryRange,
  isInsideMentionLink,
} from './plaintext-mention-autocomplete-helpers';

interface Controller {
  isVisible: () => boolean;
  filteredCount: () => number;
  cycle: (delta: 1 | -1) => void;
  selectFocused: () => boolean;
  hide: () => void;
}

const controllers = new WeakMap<EditorView, Controller>();

function positionPopover(
  popoverEl: HTMLElement,
  caretCoords: { top: number; bottom: number; left: number },
): void {
  const margin = 4;
  const popoverHeight = popoverEl.offsetHeight;
  const popoverWidth = popoverEl.offsetWidth;
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;

  let top = caretCoords.bottom + margin;
  if (
    top + popoverHeight > viewportHeight &&
    caretCoords.top - popoverHeight - margin >= 0
  ) {
    top = caretCoords.top - popoverHeight - margin;
  }
  let left = caretCoords.left;
  if (left + popoverWidth > viewportWidth) {
    left = Math.max(margin, viewportWidth - popoverWidth - margin);
  }

  popoverEl.style.top = `${String(top)}px`;
  popoverEl.style.left = `${String(left)}px`;
}

export function plaintextMentionAutocomplete({
  getOrgPeople,
}: {
  getOrgPeople: () => readonly OrgPerson[];
}): Extension {
  const plugin = ViewPlugin.fromClass(
    class implements PluginValue {
      private readonly view: EditorView;
      private readonly popoverEl: HTMLElement;
      private readonly component: ReturnType<typeof mount>;

      private filteredPeople = $state<readonly OrgPerson[]>([]);
      private selectedIndex = $state(0);
      private visible = false;
      private triggerRange: { from: number; to: number } | null = null;
      private disposed = false;

      constructor(view: EditorView) {
        this.view = view;

        this.popoverEl = document.createElement('div');
        this.popoverEl.className = 'kb1-mention-autocomplete';
        this.popoverEl.setAttribute('data-show', 'false');
        document.body.appendChild(this.popoverEl);

        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        this.component = mount(MentionAutocompletePopover, {
          target: this.popoverEl,
          props: {
            get people() {
              return self.filteredPeople;
            },
            get selectedIndex() {
              return self.selectedIndex;
            },
            onSelect: (person: OrgPerson) => {
              self.handleSelect(person);
            },
          },
        });

        controllers.set(view, {
          isVisible: () => this.visible,
          filteredCount: () => this.filteredPeople.length,
          cycle: (delta) => {
            this.cycle(delta);
          },
          selectFocused: () => {
            const choice = this.filteredPeople[this.selectedIndex];
            if (!choice) return false;
            this.handleSelect(choice);
            return true;
          },
          hide: () => {
            this.hide();
          },
        });

        this.refresh();
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet || update.focusChanged) {
          this.refresh();
        } else if (this.visible) {
          this.reposition();
        }
      }

      destroy(): void {
        this.disposed = true;
        controllers.delete(this.view);
        void unmount(this.component);
        this.popoverEl.remove();
      }

      private refresh(): void {
        const { state } = this.view;

        if (!this.view.hasFocus || !state.facet(EditorView.editable)) {
          this.hide();
          return;
        }

        const sel = state.selection.main;
        if (!sel.empty) {
          this.hide();
          return;
        }

        if (isInsideMentionLink(state, sel.head)) {
          this.hide();
          return;
        }

        const range = getQueryRange(state);
        if (range === null) {
          this.hide();
          return;
        }

        this.filteredPeople = filterPeople(getOrgPeople(), range.query);
        if (this.filteredPeople.length === 0) {
          this.selectedIndex = 0;
        } else {
          this.selectedIndex = Math.max(
            0,
            Math.min(this.selectedIndex, this.filteredPeople.length - 1),
          );
        }
        this.triggerRange = { from: range.from, to: range.to };
        this.show();
        this.reposition();
      }

      private show(): void {
        if (this.visible) return;
        this.visible = true;
        this.popoverEl.setAttribute('data-show', 'true');
      }

      private hide(): void {
        if (!this.visible) return;
        this.visible = false;
        this.triggerRange = null;
        this.popoverEl.setAttribute('data-show', 'false');
      }

      private reposition(): void {
        if (!this.visible) return;
        this.view.requestMeasure<{
          top: number;
          bottom: number;
          left: number;
        } | null>({
          key: 'kb1-mention-autocomplete-reposition',
          read: (view) => {
            if (this.disposed || !this.visible) return null;
            const cursor = view.state.selection.main.head;
            return view.coordsAtPos(cursor);
          },
          write: (coords) => {
            if (this.disposed || !this.visible || coords === null) return;
            positionPopover(this.popoverEl, coords);
          },
        });
      }

      private cycle(delta: 1 | -1): void {
        const len = this.filteredPeople.length;
        if (len === 0) return;
        if (delta === 1) {
          this.selectedIndex = Math.min(this.selectedIndex + 1, len - 1);
        } else {
          this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        }
      }

      private handleSelect(person: OrgPerson): void {
        if (this.triggerRange === null) return;
        const { from, to } = this.triggerRange;
        const insert = formatMentionInsertion(person);
        this.view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
        });
        this.hide();
        this.view.focus();
      }
    },
  );

  const handlers = keymap.of([
    {
      key: 'ArrowDown',
      run(view) {
        const controller = controllers.get(view);
        if (!controller?.isVisible()) return false;
        if (controller.filteredCount() === 0) return false;
        controller.cycle(1);
        return true;
      },
    },
    {
      key: 'ArrowUp',
      run(view) {
        const controller = controllers.get(view);
        if (!controller?.isVisible()) return false;
        if (controller.filteredCount() === 0) return false;
        controller.cycle(-1);
        return true;
      },
    },
    {
      key: 'Enter',
      run(view) {
        const controller = controllers.get(view);
        if (!controller?.isVisible()) return false;
        if (controller.filteredCount() === 0) {
          controller.hide();
          return false;
        }
        return controller.selectFocused();
      },
    },
    {
      key: 'Escape',
      run(view) {
        const controller = controllers.get(view);
        if (!controller?.isVisible()) return false;
        controller.hide();
        return true;
      },
    },
    {
      key: ' ',
      run(view) {
        const controller = controllers.get(view);
        if (!controller?.isVisible()) return false;
        controller.hide();
        return false;
      },
    },
  ]);

  return [Prec.high(handlers), plugin];
}
