import { useState } from 'react';
import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react';
import {
  defaultBoardPreferences,
  moveColumn,
  parseBoardPreferences,
  type BoardPreferences,
} from '../lib/board';
import { statuses } from '../lib/model';
import { Modal, StatusIcon } from './ui';
import './board.css';

export function BoardSettings({
  value,
  onSave,
  onClose,
}: {
  value: BoardPreferences;
  onSave: (value: BoardPreferences) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const visibleCount = draft.columns.filter(
    (column) => !column.hidden && (draft.showDone || !['done', 'canceled'].includes(column.id)),
  ).length;
  return (
    <Modal title="Customize board" onClose={onClose} className="board-settings">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave(parseBoardPreferences(JSON.stringify(draft)));
          onClose();
        }}
      >
        <div className="board-settings-body">
          <p className="muted">
            Choose your columns and their order. Changes are remembered for this board in this
            browser.
          </p>
          <h3>Columns</h3>
          <p className="muted">Rename column headings without changing item statuses.</p>
          <div className="board-settings-columns">
            {draft.columns.map((column, index) => {
              const status = statuses.find((entry) => entry.id === column.id)!;
              const completed = ['done', 'canceled'].includes(column.id);
              return (
                <div className="board-settings-column" key={column.id}>
                  <input
                    type="checkbox"
                    aria-label={`Show ${status.name} column`}
                    checked={!column.hidden}
                    disabled={completed && !draft.showDone}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        columns: draft.columns.map((entry) =>
                          entry.id === column.id
                            ? { ...entry, hidden: !event.target.checked }
                            : entry,
                        ),
                      })
                    }
                  />
                  <StatusIcon status={column.id} />
                  <label>
                    <span>{status.name}</span>
                    <input
                      className="input"
                      aria-label={`${status.name} column name`}
                      maxLength={60}
                      value={column.name}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          columns: draft.columns.map((entry) =>
                            entry.id === column.id ? { ...entry, name: event.target.value } : entry,
                          ),
                        })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Move ${status.name} column left`}
                    disabled={index === 0}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        columns: moveColumn(draft.columns, column.id, draft.columns[index - 1].id),
                      })
                    }
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Move ${status.name} column right`}
                    disabled={index === draft.columns.length - 1}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        columns: moveColumn(draft.columns, column.id, draft.columns[index + 1].id),
                      })
                    }
                  >
                    <ArrowDown size={15} />
                  </button>
                </div>
              );
            })}
          </div>
          {!visibleCount && (
            <p role="alert">Keep at least one visible column, or show completed items.</p>
          )}
          <h3>Cards</h3>
          <label className="check-field">
            <input
              type="checkbox"
              checked={draft.compact}
              onChange={(event) => setDraft({ ...draft, compact: event.target.checked })}
            />
            Compact cards
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={draft.showLabels}
              onChange={(event) => setDraft({ ...draft, showLabels: event.target.checked })}
            />
            Show tags
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={draft.showDone}
              onChange={(event) => setDraft({ ...draft, showDone: event.target.checked })}
            />
            Show completed items and columns
          </label>
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="button"
            onClick={() => setDraft(defaultBoardPreferences())}
          >
            <RotateCcw size={14} />
            Reset defaults
          </button>
          <div className="toolbar-spacer" />
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!visibleCount}>
            Apply changes
          </button>
        </div>
      </form>
    </Modal>
  );
}
