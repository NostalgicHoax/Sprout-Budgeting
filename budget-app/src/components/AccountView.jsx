import { useCallback, useEffect, useState } from 'react';
import { fmt, fmtDate, parseAmount, today } from '../money.js';
import { payeeKey } from '../../shared/payee-key.js';
import { api } from '../api.js';
import LoanPanel from './LoanPanel.jsx';
import ConfirmButton from './ConfirmButton.jsx';

export default function AccountView({ state, accountId, categoryId, refresh, onAccountDeleted }) {
  const [txns, setTxns] = useState(null);
  const [payees, setPayees] = useState([]);
  const [payeeCats, setPayeeCats] = useState(new Map());
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [acctMenu, setAcctMenu] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  // anchor for shift-click range selection, so a long run can be picked without
  // ticking every box
  const [lastClicked, setLastClicked] = useState(null);

  const isCategory = categoryId != null;
  const isAll = accountId === 'all';
  const showAccountCol = isAll || isCategory;
  const account = showAccountCol ? null : state.accounts.find(a => a.id === accountId);
  const category = isCategory
    ? state.groups.flatMap(g => g.categories).find(c => c.id === categoryId)
    : null;
  const balance = isCategory
    ? (txns ?? []).reduce((s, t) => s + t.amount, 0)
    : isAll
      ? state.accounts.reduce((s, a) => s + a.balance, 0)
      : account?.balance ?? 0;

  const load = useCallback(async () => {
    const query = isCategory ? `?categoryId=${categoryId}` : isAll ? '' : `?accountId=${accountId}`;
    setTxns(await api(`/api/transactions${query}`));
    setPayees(await api('/api/payees'));
    setPayeeCats(new Map((await api('/api/payee-categories')).map(e => [e.key, e])));
  }, [accountId, categoryId, isAll, isCategory]);

  useEffect(() => { load(); }, [load]);

  // switching accounts or categories shows a different list; carrying a
  // selection across would put rows the user can no longer see under the
  // delete button
  useEffect(() => { setSelected(new Set()); setLastClicked(null); }, [accountId, categoryId]);

  async function mutated() {
    await Promise.all([refresh(), load()]);
  }

  async function remove(id) {
    await api(`/api/transactions/${id}`, { method: 'DELETE' });
    await mutated();
  }

  function toggle(id, index, shiftKey) {
    setSelected(prev => {
      const next = new Set(prev);
      if (shiftKey && lastClicked != null) {
        // extend from the anchor, matching the anchor's resulting state
        const [lo, hi] = lastClicked < index ? [lastClicked, index] : [index, lastClicked];
        const turningOn = !prev.has(id);
        for (let i = lo; i <= hi; i++) {
          const rowId = txns[i]?.id;
          if (rowId == null) continue;
          if (turningOn) next.add(rowId); else next.delete(rowId);
        }
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setLastClicked(index);
  }

  async function deleteSelected() {
    await api('/api/transactions/bulk-delete', { method: 'POST', body: { ids: [...selected] } });
    setSelected(new Set());
    setLastClicked(null);
    setEditingId(null);
    await mutated();
  }

  if (!txns) return <main className="main" />;

  const allSelected = txns.length > 0 && txns.every(t => selected.has(t.id));
  const someSelected = selected.size > 0 && !allSelected;

  return (
    <main className="main">
      <header className="topbar account-topbar">
        <div>
          <div className="account-title">
            {isCategory
              ? `${category?.emoji ? `${category.emoji} ` : ''}${category?.name ?? 'Category'}`
              : isAll ? 'All Accounts' : account?.name}
          </div>
          <div className="account-subtitle">
            {isCategory ? 'All transactions in this category'
              : isAll ? `${state.accounts.length} accounts` : {
                cash: 'Cash account', credit: 'Credit card', loan: 'Loan — tracking only, transactions don’t affect the budget',
              }[account?.type]}
            {account?.connectionId && (
              <span className="synced-tag"> · 🏦 {state.connections?.find(c => c.id === account.connectionId)?.name ?? 'synced'}</span>
            )}
          </div>
        </div>
        <div className="account-balance">
          <div className={`balance-amount ${balance < 0 ? 'neg' : ''}`}>{fmt(balance)}</div>
          <div className="balance-label">{isCategory ? 'Net Activity' : isAll ? 'Total Balance' : 'Balance'}</div>
        </div>
        <div className="spacer" />
        {account && (
          <button
            className="btn btn-ghost"
            onClick={e => setAcctMenu(e.currentTarget.getBoundingClientRect())}
            title="Rename, close, or delete this account"
          >
            ⚙ Account <span className="rta-caret">▾</span>
          </button>
        )}
        <button className="btn btn-accent" onClick={() => { setAdding(true); setEditingId(null); }}>
          ＋ Add Transaction
        </button>
      </header>

      {acctMenu && account && (
        <AccountMenu
          anchor={acctMenu}
          account={account}
          onClose={() => setAcctMenu(null)}
          onRename={() => { setAcctMenu(null); setRenaming(true); }}
          onDelete={() => { setAcctMenu(null); setDeleting(true); }}
          onToggleClosed={async () => {
            await api(`/api/accounts/${account.id}`, { method: 'PATCH', body: { closed: !account.closed } });
            setAcctMenu(null);
            await refresh();
          }}
        />
      )}
      {renaming && account && (
        <RenameAccount account={account} onClose={() => setRenaming(false)} onDone={mutated} />
      )}
      {deleting && account && (
        <DeleteAccount
          account={account}
          onClose={() => setDeleting(false)}
          onDone={async () => { setDeleting(false); await refresh(); onAccountDeleted?.(); }}
        />
      )}

      {account?.type === 'loan' && <LoanPanel key={account.id} account={account} refresh={refresh} />}

      {selected.size > 0 && (
        <div className="selection-bar">
          <span className="selection-count">
            {selected.size} selected
            <span className="selection-total"> · {fmt(txns.filter(t => selected.has(t.id)).reduce((s, t) => s + t.amount, 0))}</span>
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => { setSelected(new Set()); setLastClicked(null); }}>
            Clear
          </button>
          <ConfirmButton
            label={`🗑 Delete ${selected.size}`}
            confirmLabel={`Confirm delete ${selected.size}`}
            title="Delete every selected transaction"
            onConfirm={deleteSelected}
          />
        </div>
      )}

      <div className="table-scroll">
      <div className={`grid-row txn-grid col-head ${showAccountCol ? 'with-account' : ''}`}>
        <div className="sel-cell">
          <input
            type="checkbox"
            checked={allSelected}
            ref={el => { if (el) el.indeterminate = someSelected; }}
            onChange={() => {
              setSelected(allSelected ? new Set() : new Set(txns.map(t => t.id)));
              setLastClicked(null);
            }}
            title={allSelected ? 'Clear selection' : 'Select every transaction shown'}
            aria-label="Select all transactions"
          />
        </div>
        <div>DATE</div>
        {showAccountCol && <div>ACCOUNT</div>}
        <div>PAYEE</div>
        <div>CATEGORY</div>
        <div>MEMO</div>
        <div className="num">OUTFLOW</div>
        <div className="num">INFLOW</div>
      </div>

      <div className="table-body">
        {adding && (
          <TxnEditor
            state={state}
            payees={payees}
            payeeCats={payeeCats}
            showAccount={showAccountCol}
            defaultAccountId={showAccountCol ? state.accounts.find(a => !a.closed)?.id : accountId}
            defaultCatValue={isCategory ? `cat:${categoryId}` : undefined}
            refresh={refresh}
            onSave={async body => {
              // loan payments have their own endpoint: it splits interest from
              // principal and steps the term down by one payment
              const url = body.kind === 'loan-payment' ? '/api/loan-payment' : '/api/transactions';
              await api(url, { method: 'POST', body });
              await mutated();
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        )}
        {txns.map((t, i) =>
          editingId === t.id ? (
            <TxnEditor
              key={t.id}
              state={state}
              payees={payees}
              payeeCats={payeeCats}
              showAccount={showAccountCol}
              txn={t}
              refresh={refresh}
              onSave={async body => { await api(`/api/transactions/${t.id}`, { method: 'PATCH', body }); await mutated(); setEditingId(null); }}
              onCancel={() => setEditingId(null)}
              onDelete={async () => { await remove(t.id); setEditingId(null); }}
            />
          ) : (
            <TxnRow
              key={t.id}
              txn={t}
              showAccount={showAccountCol}
              selected={selected.has(t.id)}
              onToggle={e => toggle(t.id, i, e.shiftKey)}
              onEdit={() => { setEditingId(t.id); setAdding(false); }}
            />
          )
        )}
        {txns.length === 0 && !adding && (
          <div className="empty-state">No transactions yet. Click “＋ Add Transaction” to record one.</div>
        )}
      </div>
      </div>
    </main>
  );
}

function AccountMenu({ anchor, account, onClose, onRename, onDelete, onToggleClosed }) {
  const style = {
    position: 'fixed',
    top: anchor.bottom + 6,
    left: Math.max(12, Math.min(anchor.left, window.innerWidth - 236)),
    width: 224,
  };
  return (
    <>
      <div className="menu-overlay" onClick={onClose} />
      <div className="budget-menu acct-menu" style={style}>
        <div className="menu-item" onClick={onRename}>✏️ Rename…</div>
        <div className="menu-item" onClick={onToggleClosed}>
          {account.closed ? '📂 Reopen account' : '📦 Close account'}
        </div>
        <div className="menu-divider" />
        <div className="menu-item danger" onClick={onDelete}>🗑 Delete account…</div>
        <div className="menu-item static">
          {account.closed
            ? 'Reopening puts it back in the sidebar.'
            : 'Closing hides it but keeps every transaction.'}
        </div>
      </div>
    </>
  );
}

function RenameAccount({ account, onClose, onDone }) {
  const [name, setName] = useState(account.name);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function save(e) {
    e.preventDefault();
    if (!name.trim()) { setError('Enter a name'); return; }
    setSaving(true);
    try {
      await api(`/api/accounts/${account.id}`, { method: 'PATCH', body: { name: name.trim() } });
      await onDone();
      onClose();
    } catch (err) { setError(err.message); setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={save}>
        <h3>Rename account</h3>
        <label>
          Name
          <input autoFocus value={name} onChange={e => setName(e.target.value)} />
        </label>
        {account.type === 'credit' && (
          <p className="modal-hint">Its payment category is renamed to match.</p>
        )}
        {error && <p className="soft-error">{error}</p>}
        <div className="popover-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-accent btn-sm" disabled={saving}>Save</button>
        </div>
      </form>
    </div>
  );
}

/** Deleting an account can't be undone, so this shows what goes with it before
 *  asking — transaction count, the money it takes back out of Ready to Assign,
 *  and which other accounts keep a re-filed row. */
function DeleteAccount({ account, onClose, onDone }) {
  const [impact, setImpact] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/api/accounts/${account.id}/deletion-impact`).then(setImpact).catch(e => setError(e.message));
  }, [account.id]);

  async function confirm() {
    setBusy(true);
    try {
      await api(`/api/accounts/${account.id}`, { method: 'DELETE' });
      await onDone();
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal delete-modal" onClick={e => e.stopPropagation()}>
        <h3>Delete “{account.name}”?</h3>
        {!impact && !error && <p className="modal-hint">Working out what this affects…</p>}
        {impact && (
          <>
            <ul className="impact-list">
              <li>
                <strong>{impact.transactions}</strong> transaction{impact.transactions === 1 ? '' : 's'} on this
                account will be deleted.
              </li>
              {impact.incomeRemoved !== 0 && (
                <li className="warn">
                  Ready to Assign drops by <strong>{fmt(Math.abs(impact.incomeRemoved))}</strong>, because income
                  recorded here goes too.
                </li>
              )}
              {impact.category && (
                <li>
                  The payment category <strong>{impact.category.name}</strong> is removed
                  {impact.category.assigned !== 0 && (
                    <> and the <strong>{fmt(impact.category.assigned)}</strong> assigned to it returns to Ready to Assign</>
                  )}.
                </li>
              )}
              {impact.stranded.map(s => (
                <li key={s.account}>
                  <strong>{s.count}</strong> transfer{s.count === 1 ? '' : 's'} on <strong>{s.account}</strong> stay
                  put as uncategorized — that balance doesn’t change.
                </li>
              ))}
              {impact.connection && (
                <li>It stops syncing from <strong>{impact.connection}</strong>.</li>
              )}
            </ul>
            <p className="modal-hint">
              This can’t be undone. To keep the history instead, close the account.
            </p>
          </>
        )}
        {error && <p className="soft-error">{error}</p>}
        <div className="popover-actions">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <ConfirmButton
            label="Delete account"
            confirmLabel="Yes, delete it"
            disabled={!impact || busy}
            onConfirm={confirm}
          />
        </div>
      </div>
    </div>
  );
}

function categoryLabel(t) {
  if (t.is_income) return <span className="cat-tag income">💵 Ready to Assign</span>;
  if (t.is_transfer) return <span className="cat-tag muted">🔁 Transfer / Payment</span>;
  if (t.is_starting) return <span className="cat-tag muted">Starting Balance</span>;
  if (t.category_id == null) return <span className="cat-tag warn">Uncategorized</span>;
  return <span className="cat-tag">{t.category_emoji ? `${t.category_emoji} ` : ''}{t.category_name}</span>;
}

function TxnRow({ txn: t, showAccount, selected, onToggle, onEdit }) {
  return (
    <div
      className={`grid-row txn-grid row ${showAccount ? 'with-account' : ''} ${!t.cleared ? 'pending-txn' : ''} ${selected ? 'selected' : ''}`}
      title={!t.cleared ? 'Pending — double-click to edit' : 'Double-click to edit'}
      onDoubleClick={onEdit}
    >
      {/* the click is stopped here so ticking a box never starts an edit */}
      <div className="sel-cell" onDoubleClick={e => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          onClick={onToggle}
          onChange={() => {}}
          aria-label={`Select transaction ${t.payee || fmtDate(t.date)}`}
          title="Select — shift-click to extend"
        />
      </div>
      <div className="muted">{fmtDate(t.date)}</div>
      {showAccount && <div className="soft">{t.account_name}</div>}
      <div className="soft">
        {t.is_recurring ? '🔁 ' : ''}
        {t.is_transfer
          ? `⇄ ${t.amount < 0 ? 'To' : 'From'}: ${t.transfer_account_name || t.payee || '—'}`
          : t.payee}
      </div>
      <div>{categoryLabel(t)}</div>
      <div className="muted ellipsis">{t.memo}</div>
      <div className="num">{t.amount < 0 ? fmt(-t.amount) : ''}</div>
      <div className={`num ${t.amount > 0 ? 'pos' : ''}`}>{t.amount > 0 ? fmt(t.amount) : ''}</div>
    </div>
  );
}

function PayeeInput({ value, onChange, payees, autoFocus }) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);

  const query = value.trim().toLowerCase();
  const matches = (query === '' ? payees : payees.filter(p => p.toLowerCase().includes(query))).slice(0, 8);
  // payees are free-entry strings; the "new" row is an affordance confirming
  // that saving the transaction will create this payee
  const isNew = query !== '' && !payees.some(p => p.toLowerCase() === query);
  const items = [
    ...matches.map(p => ({ kind: 'existing', label: p })),
    ...(isNew ? [{ kind: 'create', label: value.trim() }] : []),
  ];
  const visible = open && items.length > 0 &&
    !(items.length === 1 && items[0].kind === 'existing' && items[0].label === value);

  function pick(item) {
    if (item.kind === 'existing') onChange(item.label);
    setOpen(false);
  }

  return (
    <div className="payee-wrap">
      <input
        placeholder="Payee"
        value={value}
        autoFocus={autoFocus}
        onChange={e => { onChange(e.target.value); setOpen(true); setHighlighted(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={e => {
          if (!visible) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted(h => Math.min(h + 1, items.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(items[Math.min(highlighted, items.length - 1)]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {visible && (
        <div className="payee-menu">
          {items.map((item, i) => (
            <div
              key={`${item.kind}:${item.label}`}
              className={`payee-option ${item.kind === 'create' ? 'create' : ''} ${i === highlighted ? 'active' : ''}`}
              onMouseDown={e => { e.preventDefault(); pick(item); }}
              onMouseEnter={() => setHighlighted(i)}
            >
              {item.kind === 'create' ? `＋ New payee “${item.label}”` : item.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NewCategoryPopover({ anchor, groups, refresh, onClose, onCreated }) {
  const regular = groups.filter(g => !g.isPaymentGroup);
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState(regular[0] ? String(regular[0].id) : 'new-group');
  const [groupName, setGroupName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let gid = groupId;
      if (gid === 'new-group') {
        const g = await api('/api/groups', { method: 'POST', body: { name: groupName } });
        gid = g.id;
      }
      // a leading emoji becomes the category icon (same rule as the budget table)
      const trimmed = name.trim();
      const m = trimmed.match(/^(\p{Extended_Pictographic}(?:️)?)\s*(.*)$/u);
      const body = m && m[2]
        ? { groupId: Number(gid), emoji: m[1], name: m[2] }
        : { groupId: Number(gid), name: trimmed };
      const created = await api('/api/categories', { method: 'POST', body });
      await refresh();
      onCreated(created.id);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const style = {
    position: 'fixed',
    top: Math.max(12, Math.min(anchor.bottom + 6, window.innerHeight - 320)),
    left: Math.max(12, Math.min(anchor.left, window.innerWidth - 304)),
  };

  return (
    <>
      <div className="menu-overlay" onClick={onClose} />
      <form className="popover" style={style} onSubmit={create}>
        <div className="popover-title">New Category</div>
        <label>
          Name
          <input
            autoFocus required placeholder="Emoji optional, e.g. 🎮 Games"
            value={name} onChange={e => setName(e.target.value)}
          />
        </label>
        <label>
          Group
          <select value={groupId} onChange={e => setGroupId(e.target.value)}>
            {regular.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            <option value="new-group">＋ New group…</option>
          </select>
        </label>
        {groupId === 'new-group' && (
          <label>
            Group name
            <input required placeholder="e.g. Fun Money" value={groupName} onChange={e => setGroupName(e.target.value)} />
          </label>
        )}
        {error && <p className="modal-error">{error}</p>}
        <div className="popover-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-accent btn-sm" disabled={busy}>Create</button>
        </div>
      </form>
    </>
  );
}

function TxnEditor({ state, payees, payeeCats, showAccount, txn, defaultAccountId, defaultCatValue, onSave, onCancel, onDelete, refresh }) {
  const initialCatValue = txn == null ? (defaultCatValue ?? 'uncategorized')
    : txn.is_income ? 'income'
    : txn.is_transfer ? 'transfer'
    : txn.category_id != null ? `cat:${txn.category_id}`
    : 'uncategorized';

  const [accountId, setAccountId] = useState(txn?.account_id ?? defaultAccountId);
  const [date, setDate] = useState(txn?.date ?? today());
  const [payee, setPayee] = useState(txn?.payee ?? '');
  const [transferAccountId, setTransferAccountId] = useState(
    txn?.transfer_account_id ? String(txn.transfer_account_id) : ''
  );
  const [memo, setMemo] = useState(txn?.memo ?? '');
  const [catValue, setCatValue] = useState(initialCatValue);
  const [outflow, setOutflow] = useState(txn && txn.amount < 0 ? (-txn.amount / 100).toFixed(2) : '');
  const [inflow, setInflow] = useState(txn && txn.amount > 0 ? (txn.amount / 100).toFixed(2) : '');
  const [cleared, setCleared] = useState(txn ? !!txn.cleared : true);
  const [recurring, setRecurring] = useState(txn ? !!txn.is_recurring : false);
  const [newCatAnchor, setNewCatAnchor] = useState(null);
  const [error, setError] = useState(null);
  // once the user picks a category by hand, the payee rule stops overwriting it
  const [catTouched, setCatTouched] = useState(initialCatValue !== 'uncategorized');
  const [autoFilled, setAutoFilled] = useState(false);

  const memory = payeeCats?.get(payeeKey(payee));
  const allCats = state.groups.flatMap(g => g.categories);
  const suggested = (memory?.suggestions ?? [])
    .map(id => allCats.find(c => c.id === id))
    .filter(Boolean);

  // a new transaction for a known payee lands in that payee's last category —
  // filled in visibly here rather than silently, so it can be corrected
  const rule = memory?.rule ?? null;
  useEffect(() => {
    if (catTouched) return;
    if (rule != null) {
      setCatValue(`cat:${rule}`);
      setAutoFilled(true);
    } else {
      // payee cleared or changed to an unknown one — take the guess back
      setCatValue(prev => (prev.startsWith('cat:') ? 'uncategorized' : prev));
      setAutoFilled(false);
    }
  }, [rule, catTouched]);

  async function save() {
    const out = parseAmount(outflow || '0');
    const inn = parseAmount(inflow || '0');
    if (out == null || inn == null) { setError('Enter a valid amount'); return; }
    if (catValue === 'transfer') {
      if (!transferAccountId) { setError('Choose the account this transfers to'); return; }
      if (Number(transferAccountId) === Number(accountId)) { setError('A transfer needs two different accounts'); return; }
    }
    if (catValue === 'loan-payment') {
      if (!transferAccountId) { setError('Choose the loan you paid'); return; }
      if (out <= 0) { setError('Enter the amount you paid as an outflow'); return; }
      try {
        await onSave({
          kind: 'loan-payment',
          fromAccountId: Number(accountId),
          loanAccountId: Number(transferAccountId),
          amount: out, date, memo,
        });
      } catch (e) {
        setError(e.message);
      }
      return;
    }
    const amount = inn - out;
    const body = {
      accountId: Number(accountId), date, payee, memo, amount,
      kind: catValue.startsWith('cat:') ? 'category' : catValue,
      categoryId: catValue.startsWith('cat:') ? Number(catValue.slice(4)) : undefined,
      transferAccountId: catValue === 'transfer' ? Number(transferAccountId) : undefined,
      cleared, recurring,
    };
    try {
      await onSave(body);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <>
      <div className={`grid-row txn-grid row editor ${showAccount ? 'with-account' : ''}`}>
        <div className="sel-cell" />{/* keeps the editor aligned with the select column */}
        <div><input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
        {showAccount && (
          <div>
            <select value={accountId} onChange={e => setAccountId(e.target.value)}>
              {state.accounts.filter(a => !a.closed || a.id === accountId).map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
        )}
        <div>
          {catValue === 'loan-payment' ? (
            <select
              value={transferAccountId}
              onChange={e => setTransferAccountId(e.target.value)}
              title="The loan this payment goes toward"
            >
              <option value="" disabled>🏦 Pay loan…</option>
              {state.accounts
                .filter(a => a.type === 'loan' && !a.closed)
                .map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          ) : catValue === 'transfer' ? (
            <select
              value={transferAccountId}
              onChange={e => setTransferAccountId(e.target.value)}
              title="The other side of this transfer"
            >
              <option value="" disabled>⇄ Transfer to…</option>
              {state.accounts
                .filter(a => !a.closed && a.id !== Number(accountId))
                .map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          ) : (
            <PayeeInput value={payee} onChange={setPayee} payees={payees} autoFocus={!txn} />
          )}
        </div>
        <div>
          <select
            className={autoFilled ? 'auto-filled' : ''}
            title={autoFilled ? `Filled in from the last time you categorized “${payee.trim()}”` : undefined}
            value={catValue}
            onChange={e => {
              setCatTouched(true);
              setAutoFilled(false);
              if (e.target.value === 'new-category') {
                // keep the current selection; the popover assigns the new one
                setNewCatAnchor(e.target.getBoundingClientRect());
              } else {
                setCatValue(e.target.value);
              }
            }}
          >
            {suggested.length > 0 && (
              // this payee's usual categories, ahead of the full list — same
              // values as below, so picking either resolves to one category
              <optgroup label={`⭐ Usually for ${payee.trim()}`}>
                {suggested.map(c => (
                  <option key={`sug-${c.id}`} value={`cat:${c.id}`}>{c.emoji ? `${c.emoji} ` : ''}{c.name}</option>
                ))}
              </optgroup>
            )}
            <option value="income">💵 Inflow: Ready to Assign</option>
            <option value="transfer">🔁 Transfer / Card Payment</option>
            {/* only for new entries: re-splitting interest and stepping the term
                back on an edit isn't supported, so the server rejects it */}
            {!txn && state.accounts.some(a => a.type === 'loan' && !a.closed) && (
              <option value="loan-payment">🏦 Loan Payment</option>
            )}
            <option value="uncategorized">Uncategorized</option>
            <option value="new-category">＋ New category…</option>
            {state.groups.map(g => (
              <optgroup key={g.id} label={g.name}>
                {g.categories.map(c => (
                  <option key={c.id} value={`cat:${c.id}`}>{c.emoji ? `${c.emoji} ` : ''}{c.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div><input placeholder="Memo" value={memo} onChange={e => setMemo(e.target.value)} /></div>
        <div><input className="num-input" placeholder="0.00" inputMode="decimal" value={outflow} onChange={e => { setOutflow(e.target.value); setInflow(''); }} /></div>
        <div><input className="num-input" placeholder="0.00" inputMode="decimal" value={inflow} onChange={e => { setInflow(e.target.value); setOutflow(''); }} /></div>
      </div>
      <div className="editor-options">
        <label>
          <input type="checkbox" checked={cleared} onChange={e => setCleared(e.target.checked)} />
          ✓ Cleared
        </label>
        <label>
          <input type="checkbox" checked={recurring} onChange={e => setRecurring(e.target.checked)} />
          🔁 Recurring
        </label>
        {error && <span className="editor-error-inline">{error}</span>}
        <div className="editor-actions">
          {onDelete && <ConfirmButton onConfirm={onDelete} title="Delete this transaction" />}
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
          <button className="btn btn-accent btn-sm" onClick={save}>Save</button>
        </div>
      </div>
      {newCatAnchor && (
        <NewCategoryPopover
          anchor={newCatAnchor}
          groups={state.groups}
          refresh={refresh}
          onClose={() => setNewCatAnchor(null)}
          onCreated={id => { setCatValue(`cat:${id}`); setNewCatAnchor(null); }}
        />
      )}
    </>
  );
}
