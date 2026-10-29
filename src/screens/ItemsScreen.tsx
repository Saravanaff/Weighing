import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Item } from '../lib/types.ts';
import { api } from '../api.ts';
import { IMAGE_ACCEPT, fileToResizedDataUrl } from '../lib/itemImage.ts';
import { itemImageUrl } from '../lib/serverAddress.ts';

const NATIVE_FIELDS: Array<{ key: 'name_hi' | 'name_bn' | 'name_ta'; label: string; placeholder: string }> = [
  { key: 'name_hi', label: 'Hindi Name', placeholder: 'Optional' },
  { key: 'name_bn', label: 'Bengali Name', placeholder: 'Optional' },
  { key: 'name_ta', label: 'Tamil Name', placeholder: 'Optional' },
];

const MAX_NAME_LENGTH = 60;

export interface ItemsScreenProps {
  items: Item[];
  itemsLoading: boolean;
  itemsError: string;
  onItemsChanged: () => void | Promise<void>;
}

export function ItemsScreen({
  items,
  itemsLoading,
  itemsError,
  onItemsChanged,
}: ItemsScreenProps) {
  const [name, setName] = useState('');
  const [native, setNative] = useState({ name_hi: '', name_bn: '', name_ta: '' });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  // The row whose names/voice clips are being regenerated on the server.
  const [regeneratingId, setRegeneratingId] = useState<number | null>(null);
  // The add form is 430px tall on a phone and is needed rarely, so it starts
  // closed and the master list starts at the top of the screen instead of
  // below it.
  const [formOpen, setFormOpen] = useState(false);
  const [search, setSearch] = useState('');

  // A picture picked in the ADD ITEM form. The data URL is what gets uploaded,
  // and it doubles as the preview shown before the item is saved.
  const [pickedImage, setPickedImage] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const addFileRef = useRef<HTMLInputElement | null>(null);
  // Per-item picture editing in the master list. The id of the row currently
  // being changed, plus the two-tap confirm used for removals.
  const [editingImageId, setEditingImageId] = useState<number | null>(null);
  const [removingImageId, setRemovingImageId] = useState<number | null>(null);
  const editFileRef = useRef<HTMLInputElement | null>(null);

  // Editing one item happens in its own dialog, so the add form on the page
  // keeps its state and the operator is not scrolled away from the row.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editNative, setEditNative] = useState({ name_hi: '', name_bn: '', name_ta: '' });
  const [editPickedImage, setEditPickedImage] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState('');
  const [editImageBusy, setEditImageBusy] = useState(false);
  const editModalRef = useRef<HTMLDivElement | null>(null);
  const editModalFileRef = useRef<HTMLInputElement | null>(null);

  const needle = search.trim().toLowerCase();
  const visibleItems = needle
    ? items.filter((item) =>
        [item.code, item.name, item.names.hi, item.names.bn, item.names.ta].some((value) =>
          (value || '').toLowerCase().includes(needle),
        ),
      )
    : items;

  const editingItem = editingId == null ? null : items.find((item) => item.id === editingId) ?? null;
  const editImage =
    editPickedImage ?? (editingItem ? itemImageUrl(editingItem.imagePath) : null);

  function closeEdit() {
    setEditingId(null);
    setEditName('');
    setEditNative({ name_hi: '', name_bn: '', name_ta: '' });
    setEditPickedImage(null);
    setEditError('');
  }

  function startEdit(item: Item) {
    setEditingId(item.id);
    setEditName(item.name);
    setEditNative({
      name_hi: item.names.hi || '',
      name_bn: item.names.bn || '',
      name_ta: item.names.ta || '',
    });
    setEditPickedImage(null);
    setEditError('');
  }

  useEffect(() => {
    if (editingId == null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !editSubmitting) closeEdit();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [editingId, editSubmitting]);

  function validateNames(
    itemName: string,
    names: { name_hi: string; name_bn: string; name_ta: string },
  ): string | null {
    if (!itemName) return 'Item name is required';
    if (itemName.length > MAX_NAME_LENGTH) {
      return `Item name must be ${MAX_NAME_LENGTH} characters or fewer`;
    }
    for (const field of NATIVE_FIELDS) {
      if (names[field.key].length > MAX_NAME_LENGTH) {
        return `${field.label} must be ${MAX_NAME_LENGTH} characters or fewer`;
      }
    }
    return null;
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    const invalid = validateNames(trimmedName, native);
    if (invalid) {
      setFormError(invalid);
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      const created = await api.createItem({ name: trimmedName, ...native });
      // The picture is uploaded after the item exists, because the row has to
      // exist before it can point at a file. A failure here leaves the item
      // saved without a photo, which the operator can fix with EDIT PICTURE.
      if (pickedImage) {
        try {
          await api.uploadItemImage(created.id, pickedImage);
        } catch (err) {
          setFormError(
            `Item added, but the picture could not be uploaded: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      setName('');
      setNative({ name_hi: '', name_bn: '', name_ta: '' });
      setPickedImage(null);
      onItemsChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleEditSubmit(event: FormEvent) {
    event.preventDefault();
    if (editingId == null) return;
    const trimmedName = editName.trim();
    const invalid = validateNames(trimmedName, editNative);
    if (invalid) {
      setEditError(invalid);
      return;
    }
    setEditSubmitting(true);
    setEditError('');
    try {
      await api.updateItem(editingId, { name: trimmedName, ...editNative });
      if (editPickedImage) {
        try {
          await api.uploadItemImage(editingId, editPickedImage);
        } catch (err) {
          setEditError(
            `Item saved, but the picture could not be uploaded: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          onItemsChanged();
          return;
        }
      }
      closeEdit();
      onItemsChanged();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditSubmitting(false);
    }
  }

  function chooseEditImage() {
    editModalFileRef.current?.click();
  }

  async function handleEditImagePicked(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setEditImageBusy(true);
    setEditError('');
    try {
      setEditPickedImage(await fileToResizedDataUrl(file));
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditImageBusy(false);
    }
  }

  /** Opens the picker for the ADD ITEM form. */
  function chooseNewImage() {
    addFileRef.current?.click();
  }

  async function handlePickedImage(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset first so picking the same file twice still fires a change event.
    event.target.value = '';
    if (!file) return;
    setImageBusy(true);
    setFormError('');
    try {
      setPickedImage(await fileToResizedDataUrl(file));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setImageBusy(false);
    }
  }

  /** Opens the picker for one row of the master list. */
  function chooseExistingImage(item: Item) {
    setEditingImageId(item.id);
    setFormError('');
    editFileRef.current?.click();
  }

  async function handleExistingImagePicked(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    const itemId = editingImageId;
    setEditingImageId(null);
    if (!file || itemId == null) return;

    setImageBusy(true);
    setFormError('');
    try {
      const dataUrl = await fileToResizedDataUrl(file);
      await api.uploadItemImage(itemId, dataUrl);
      onItemsChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setImageBusy(false);
    }
  }

  async function handleRemoveImage(item: Item) {
    if (removingImageId !== item.id) {
      setRemovingImageId(item.id);
      window.setTimeout(() => {
        setRemovingImageId((current) => (current === item.id ? null : current));
      }, 3000);
      return;
    }
    setRemovingImageId(null);
    setFormError('');
    try {
      await api.removeItemImage(item.id);
      onItemsChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRegenerate(item: Item) {
    setRegeneratingId(item.id);
    setFormError('');
    try {
      await api.regenerateItem(item.id);
      onItemsChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegeneratingId(null);
    }
  }

  async function handleDelete(item: Item) {
    if (confirmingId !== item.id) {
      setConfirmingId(item.id);
      window.setTimeout(() => {
        setConfirmingId((current) => (current === item.id ? null : current));
      }, 3000);
      return;
    }
    setConfirmingId(null);
    setFormError('');
    try {
      await api.deleteItem(item.id);
      onItemsChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  }

  const hasItems = items.length > 0;

  return (
    <section className="stage">
      <div className="screen-title">ITEM MASTER</div>
      <div className="screen-sub">Add new products or remove discontinued ones from the master list.</div>

      {itemsError && (
        <div className="error-banner">
          Could not load items: {itemsError}{' '}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onItemsChanged}>
            RETRY
          </button>
        </div>
      )}

      {formError && <div className="error-banner">{formError}</div>}

      <div className="items-layout">
        <div className="panel items-form-panel">
          <button
            type="button"
            className="panel-title items-form-toggle"
            onClick={() => setFormOpen((open) => !open)}
            aria-expanded={formOpen}
          >
            <span>ADD ITEM</span>
            <span className="items-form-toggle-hint">{formOpen ? 'HIDE' : 'SHOW'}</span>
          </button>
          {formOpen && (
            <>
              <div className="panel-sub">
                Native names + voice clips for all 4 languages are generated automatically.
              </div>
              <form className="items-form" onSubmit={handleAdd}>
                <div className="form-grid">
                  <div className="form-field">
                    <div className="field-label">English Name *</div>
                    <input
                      className="text-input"
                      type="text"
                      placeholder="e.g. Oats"
                      maxLength={MAX_NAME_LENGTH}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </div>
                  {NATIVE_FIELDS.map((field) => (
                    <div className="form-field" key={field.key}>
                      <div className="field-label">{field.label}</div>
                      <input
                        className="text-input"
                        type="text"
                        placeholder={field.placeholder}
                        maxLength={MAX_NAME_LENGTH}
                        value={native[field.key]}
                        onChange={(event) =>
                          setNative((prev) => ({ ...prev, [field.key]: event.target.value }))
                        }
                      />
                    </div>
                  ))}
                  <div className="form-field">
                    <div className="field-label">Picture</div>
                    <input
                      ref={addFileRef}
                      type="file"
                      accept={IMAGE_ACCEPT}
                      className="visually-hidden-input"
                      onChange={handlePickedImage}
                    />
                    <div className="item-image-picker">
                      {pickedImage ? (
                        <img
                          className="item-image-preview"
                          src={pickedImage}
                          alt="Selected item picture"
                        />
                      ) : (
                        <div className="item-image-preview item-image-empty" aria-hidden="true">
                          NO PIC
                        </div>
                      )}
                      <div className="item-image-picker-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={chooseNewImage}
                          disabled={imageBusy}
                        >
                          {imageBusy ? 'READING…' : pickedImage ? 'CHOOSE OTHER' : 'UPLOAD PICTURE'}
                        </button>
                        {pickedImage && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setPickedImage(null)}
                            disabled={imageBusy}
                          >
                            REMOVE
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="metric-hint">Optional. Resized automatically.</div>
                  </div>
                </div>
                <div className="items-form-actions">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={submitting || !name.trim()}
                  >
                    {submitting ? 'SAVING…' : 'ADD ITEM'}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>

        <div className="panel items-list-panel">
          <div className="panel-title">MASTER LIST ({items.length})</div>
          <input
            ref={editFileRef}
            type="file"
            accept={IMAGE_ACCEPT}
            className="visually-hidden-input"
            onChange={handleExistingImagePicked}
          />
          {hasItems && (
            <div className="items-search">
              <input
                className="text-input"
                type="search"
                placeholder="Search by name or code"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {needle && (
                <span className="items-search-count">
                  {visibleItems.length} of {items.length}
                </span>
              )}
            </div>
          )}
          {itemsLoading ? (
            <div className="panel-placeholder">Loading items…</div>
          ) : !hasItems ? (
            <div className="panel-placeholder">No items yet. Add one using the form.</div>
          ) : visibleItems.length === 0 ? (
            <div className="panel-placeholder">No items match “{search.trim()}”.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Picture</th>
                    <th>Hindi</th>
                    <th>Bengali</th>
                    <th>Tamil</th>
                    <th>Added</th>
                    <th className="col-x" />
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((item: Item) => {
                    const src = itemImageUrl(item.imagePath);
                    return (
                    <tr key={item.id}>
                      <td data-label="Code" className="num item-code">{item.code}</td>
                      <td data-label="Name" className="item-name">{item.name}</td>
                      <td data-label="Picture" className="item-picture-cell">
                        {src ? (
                          <img className="item-thumb" src={src} alt={`${item.name} picture`} />
                        ) : (
                          <div className="item-thumb item-thumb-empty" aria-hidden="true" />
                        )}
                        <div className="item-picture-actions">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => chooseExistingImage(item)}
                            disabled={imageBusy && editingImageId === item.id}
                          >
                            {src ? 'CHANGE' : 'ADD'}
                          </button>
                          {src && (
                            <button
                              type="button"
                              className={`btn btn-secondary btn-sm${removingImageId === item.id ? ' confirming' : ''}`}
                              onClick={() => handleRemoveImage(item)}
                            >
                              {removingImageId === item.id ? 'CONFIRM?' : 'CLEAR'}
                            </button>
                          )}
                        </div>
                      </td>
                      <td data-label="Hindi" className="item-native">{item.names.hi || '—'}</td>
                      <td data-label="Bengali" className="item-native">{item.names.bn || '—'}</td>
                      <td data-label="Tamil" className="item-native">{item.names.ta || '—'}</td>
                      <td data-label="Added" className="num muted item-added">{(item.createdAt || '').slice(0, 10)}</td>
                      {/* Phone layout only: the code and the three native names on
                          one line, so each item is two lines instead of seven. */}
                      <td className="item-meta">
                        {[item.code, item.names.hi, item.names.bn, item.names.ta]
                          .filter(Boolean)
                          .join(' · ')}
                      </td>
                      <td className="col-x">
                        <div className="item-row-actions">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => startEdit(item)}
                          >
                            EDIT
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleRegenerate(item)}
                            disabled={regeneratingId === item.id}
                            title="Re-translate names and rebuild voice clips"
                          >
                            {regeneratingId === item.id ? 'FIXING…' : 'REGENERATE'}
                          </button>
                          <button
                            type="button"
                            className={`delete-btn${confirmingId === item.id ? ' confirming' : ''}`}
                            onClick={() => handleDelete(item)}
                          >
                            {confirmingId === item.id ? 'CONFIRM?' : 'DELETE'}
                          </button>
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {editingItem && (
        <div
          className="item-edit-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Edit ${editingItem.name}`}
          onClick={(event) => {
            if (event.target === event.currentTarget && !editSubmitting) closeEdit();
          }}
        >
          <div className="item-edit-modal" ref={editModalRef} tabIndex={-1}>
            <div className="item-edit-head">
              <div>
                <div className="item-edit-title">EDIT ITEM</div>
                <div className="item-edit-sub">
                  {editingItem.code} · changes update voice clips and formula labels
                </div>
              </div>
              <button
                type="button"
                className="item-edit-close"
                onClick={closeEdit}
                disabled={editSubmitting}
                aria-label="Close edit item"
              >
                ×
              </button>
            </div>

            <form className="items-form item-edit-form" onSubmit={handleEditSubmit}>
              <input
                ref={editModalFileRef}
                type="file"
                accept={IMAGE_ACCEPT}
                className="visually-hidden-input"
                onChange={handleEditImagePicked}
              />
              <div className="form-grid">
                <div className="form-field">
                  <div className="field-label">English Name *</div>
                  <input
                    className="text-input"
                    type="text"
                    maxLength={MAX_NAME_LENGTH}
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                    autoFocus
                  />
                </div>
                {NATIVE_FIELDS.map((field) => (
                  <div className="form-field" key={field.key}>
                    <div className="field-label">{field.label}</div>
                    <input
                      className="text-input"
                      type="text"
                      placeholder={field.placeholder}
                      maxLength={MAX_NAME_LENGTH}
                      value={editNative[field.key]}
                      onChange={(event) =>
                        setEditNative((prev) => ({ ...prev, [field.key]: event.target.value }))
                      }
                    />
                  </div>
                ))}
                <div className="form-field">
                  <div className="field-label">Picture</div>
                  <div className="item-image-picker">
                    {editImage ? (
                      <img className="item-image-preview" src={editImage} alt="Item picture" />
                    ) : (
                      <div className="item-image-preview item-image-empty" aria-hidden="true">
                        NO PIC
                      </div>
                    )}
                    <div className="item-image-picker-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={chooseEditImage}
                        disabled={editImageBusy}
                      >
                        {editImageBusy ? 'READING…' : editImage ? 'CHANGE PICTURE' : 'UPLOAD PICTURE'}
                      </button>
                      {editPickedImage && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => setEditPickedImage(null)}
                          disabled={editImageBusy}
                        >
                          UNDO
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="metric-hint">Optional. Resized automatically.</div>
                </div>
              </div>

              {editError && (
                <div className="edit-error" role="alert">
                  {editError}
                </div>
              )}

              <div className="items-form-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={closeEdit}
                  disabled={editSubmitting}
                >
                  CANCEL
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={editSubmitting || !editName.trim()}
                >
                  {editSubmitting ? 'SAVING…' : 'SAVE CHANGES'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}