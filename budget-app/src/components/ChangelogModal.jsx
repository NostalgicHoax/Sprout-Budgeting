import { CHANGELOG, APP_VERSION } from '../changelog.js';

const SEEN_KEY = 'sprout:changelog-seen';

/** The newest version the user has actually looked at. Stored per browser
 *  rather than per budget — it's about the app, not the data. */
export function lastSeenVersion() {
  try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
}

export function markChangelogSeen() {
  try { localStorage.setItem(SEEN_KEY, APP_VERSION); } catch { /* private mode — just re-show it */ }
}

/** True when there's something here the user hasn't opened yet. A brand new
 *  install counts as read: nobody wants a "what's new" badge before they've
 *  used the thing once. */
export function hasUnreadChangelog() {
  const seen = lastSeenVersion();
  if (seen == null) {
    markChangelogSeen();
    return false;
  }
  return seen !== APP_VERSION;
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** `since` is the version the user had already read when they opened this —
 *  captured before the open marks everything seen, otherwise nothing would ever
 *  be flagged new. */
export default function ChangelogModal({ onClose, since = null }) {
  const seenIndex = since == null ? -1 : CHANGELOG.findIndex(r => r.version === since);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal changelog-modal" onClick={e => e.stopPropagation()}>
        <div className="changelog-head">
          <h3>What's New</h3>
          <span className="changelog-version">Version {APP_VERSION}</span>
        </div>

        <div className="changelog-body">
          {CHANGELOG.map((release, i) => (
            <section key={release.version} className="changelog-release">
              <div className="changelog-release-head">
                <span className="changelog-release-version">{release.version}</span>
                {/* newest first, so anything above the last-read entry is new.
                    An unknown `since` marks nothing, which fails quiet. */}
                {seenIndex > i && <span className="changelog-new">NEW</span>}
                <span className="changelog-date">{formatDate(release.date)}</span>
              </div>
              <h4 className="changelog-title">{release.title}</h4>
              {release.items.map(item => (
                <div key={item.heading} className="changelog-item">
                  <div className="changelog-item-heading">{item.heading}</div>
                  <p className="changelog-item-body">{item.body}</p>
                </div>
              ))}
            </section>
          ))}
        </div>

        <div className="popover-actions">
          <button className="btn btn-accent btn-sm" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
