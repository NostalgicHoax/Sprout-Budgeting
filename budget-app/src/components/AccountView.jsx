import { useCallback, useEffect, useState } from 'react';
import { fmt, fmtDate, parseAmount, today } from '../money.js';
import { payeeKey } from '../../shared/payee-key.js';
import { api } from '../api.js';
import LoanPanel from './LoanPanel.jsx';
import ConfirmButton from './ConfirmButton.jsx';

export default function AccountView({ state, accountId, categoryId, refresh }) {
  const [txns, setTxns] = useState(null);
  const [payees, setPayees] = useState([]);
  const [payeeCats, setPayeeCats] = useState(new Map());
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);

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

  async function mutated() {
    await Promise.all([refresh(), load()]);
  }

  async function remove(id) {
    await api(`/api/transactions/${id}`, { method: 'DELETE' });
    await mutated();
  }

  if (!txns) return <main className="main" />;

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
        <button className="btn btn-accent" onClick={() => { setAdding(true); setEditingId(null); }}>
          ＋ Add Transaction
        </button>
      </header>

      {account?.type === 'loan' && <LoanPanel key={account.id} account={account} refresh={refresh} />}

      <div className="table-scroll">
      <div className={`grid-row txn-grid col-head ${showAccountCol ? 'with-account' : ''}`}>
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
            onSave={async body => { await api('/api/transactions', { method: 'POST', body }); await mutated(); setAdding(false); }}
            onCancel={() => setAdding(false)}
          />
        )}
        {txns.map(t =>
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
            <TxnRow key={t.id} txn={t} showAccount={showAccountCol} onEdit={() => { setEditingId(t.id); setAdding(false); }} />
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

function categoryLabel(t) {
  if (t.is_income) return <span className="cat-tag income">💵 Ready to Assign</span>;
  if (t.is_transfer) return <span className="cat-tag muted">🔁 Transfer / Payment</span>;
  if (t.is_starting) return <span className="cat-tag muted">Starting Balance</span>;
  if (t.category_id == null) return <span className="cat-tag warn">Uncategorized</span>;
  return <span className="cat-tag">{t.category_emoji ? `${t.category_emoji} ` : ''}{t.category_name}</span>;
}

function TxnRow({ txn: t, showAccount, onEdit }) {
  return (
    <div
      className={`grid-row txn-grid row ${showAccount ? 'with-account' : ''} ${!t.cleared ? 'pending-txn' : ''}`}
      title={!t.cleared ? 'Pending — double-click to edit' : 'Double-click to edit'}
      onDoubleClick={onEdit}
    >
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
          {catValue === 'transfer' ? (
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
