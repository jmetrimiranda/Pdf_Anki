import { ChevronRight } from 'lucide-react';
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { t } from '../../i18n';

export interface TreeNode<T> {
  id: string;
  data: T;
  children?: TreeNode<T>[];
}

export interface TreeRowState {
  level: number;
  expanded: boolean;
  hasChildren: boolean;
}

interface Visible<T> {
  node: TreeNode<T>;
  level: number;
  parentId: string | null;
}

function flatten<T>(
  nodes: TreeNode<T>[],
  expanded: ReadonlySet<string>,
  level = 1,
  parentId: string | null = null,
  out: Visible<T>[] = [],
) {
  for (const node of nodes) {
    out.push({ node, level, parentId });
    if (node.children?.length && expanded.has(node.id)) flatten(node.children, expanded, level + 1, node.id, out);
  }
  return out;
}

/**
 * Collapsible tree (WAI-ARIA tree pattern) with roving focus:
 * ↑/↓ move, → expands or enters, ← collapses or goes to the parent, Home/End, Enter activates,
 * Shift+F10 / context-menu key calls `onMenu`.
 * Rows are rendered by `renderRow`; the tree draws the indentation and the toggle.
 */
export function Tree<T>({
  nodes,
  label,
  renderRow,
  getLabel,
  onActivate,
  onMenu,
  defaultExpanded,
  expanded: expandedProp,
  onExpandedChange,
  indent = 18,
  rowClassName,
  className,
}: {
  nodes: TreeNode<T>[];
  label: string;
  renderRow: (node: TreeNode<T>, state: TreeRowState) => ReactNode;
  /** Accessible name of a row, when its text content alone does not describe it. */
  getLabel?: (node: TreeNode<T>) => string;
  onActivate?: (node: TreeNode<T>) => void;
  /** Shift+F10 or the context-menu key on a row. */
  onMenu?: (node: TreeNode<T>) => void;
  defaultExpanded?: Iterable<string>;
  expanded?: ReadonlySet<string>;
  onExpandedChange?: (expanded: Set<string>) => void;
  indent?: number;
  rowClassName?: string;
  className?: string;
}) {
  const [inner, setInner] = useState(() => new Set(defaultExpanded ?? []));
  const expanded = expandedProp ?? inner;
  const visible = useMemo(() => flatten(nodes, expanded), [nodes, expanded]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const activeId = visible.some((v) => v.node.id === focusId) ? focusId : (visible[0]?.node.id ?? null);

  function setExpanded(id: string, open: boolean) {
    const next = new Set(expanded);
    if (open) next.add(id);
    else next.delete(id);
    if (!expandedProp) setInner(next);
    onExpandedChange?.(next);
  }

  function focus(id: string | undefined) {
    if (!id) return;
    setFocusId(id);
    refs.current.get(id)?.focus();
  }

  function onKeyDown(e: KeyboardEvent, i: number) {
    const v = visible[i];
    if (!v) return;
    const hasChildren = !!v.node.children?.length;
    const isOpen = expanded.has(v.node.id);
    switch (e.key) {
      case 'ArrowDown':
        focus(visible[i + 1]?.node.id);
        break;
      case 'ArrowUp':
        focus(visible[i - 1]?.node.id);
        break;
      case 'Home':
        focus(visible[0]?.node.id);
        break;
      case 'End':
        focus(visible[visible.length - 1]?.node.id);
        break;
      case 'ArrowRight':
        if (hasChildren && !isOpen) setExpanded(v.node.id, true);
        else if (hasChildren) focus(visible[i + 1]?.node.id);
        break;
      case 'ArrowLeft':
        if (hasChildren && isOpen) setExpanded(v.node.id, false);
        else if (v.parentId) focus(v.parentId);
        break;
      case 'Enter':
        onActivate?.(v.node);
        break;
      case 'ContextMenu':
      case 'F10':
        if (!onMenu || (e.key === 'F10' && !e.shiftKey)) return;
        onMenu(v.node);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  return (
    <div role="tree" aria-label={label} className={className}>
      {visible.map((v, i) => {
        const hasChildren = !!v.node.children?.length;
        const isOpen = expanded.has(v.node.id);
        return (
          <div
            key={v.node.id}
            ref={(el) => {
              if (el) refs.current.set(v.node.id, el);
              else refs.current.delete(v.node.id);
            }}
            role="treeitem"
            aria-label={getLabel?.(v.node)}
            aria-keyshortcuts={onMenu ? 'Shift+F10' : undefined}
            aria-level={v.level}
            aria-expanded={hasChildren ? isOpen : undefined}
            aria-selected={v.node.id === activeId}
            tabIndex={v.node.id === activeId ? 0 : -1}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget) onKeyDown(e, i);
            }}
            onFocus={(e) => {
              if (e.target === e.currentTarget) setFocusId(v.node.id);
            }}
            onDoubleClick={() => onActivate?.(v.node)}
            className={cn(
              'group flex items-center rounded-ctl focus-visible:outline-offset-[-2px] hover:bg-hover',
              rowClassName,
            )}
          >
            <div style={{ width: (v.level - 1) * indent }} className="shrink-0" aria-hidden />
            {hasChildren ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label={isOpen ? t('tree.collapse') : t('tree.expand')}
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(v.node.id, !isOpen);
                }}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-[4px] text-muted hover:bg-active hover:text-fg coarse:size-10"
              >
                <ChevronRight size={15} aria-hidden className={cn('transition-transform', isOpen && 'rotate-90')} />
              </button>
            ) : (
              <span aria-hidden className="size-6 shrink-0 coarse:w-10" />
            )}
            <div className="min-w-0 flex-1">{renderRow(v.node, { level: v.level, expanded: isOpen, hasChildren })}</div>
          </div>
        );
      })}
    </div>
  );
}
