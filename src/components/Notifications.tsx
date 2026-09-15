import { useState } from 'react';
import { Bell, Check, CheckCheck, Circle } from 'lucide-react';
import type { MentionNotification } from '../../shared/types';
import { useApp } from '../lib/context';
import { navigate } from '../lib/model';
import { patch, post } from '../lib/api';
import { Avatar } from './ui';
import './notifications.css';

export function NotificationBell() {
  const { data } = useApp();
  const unread = (data.notifications ?? []).filter((n) => !n.readAt).length;
  return (
    <button
      className="icon-button notification-bell"
      aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
      title="Notifications"
      onClick={() => navigate('notifications')}
    >
      <Bell size={19} />
      {unread > 0 && (
        <span className="notification-count" aria-hidden="true">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}

export default function Notifications({ tab }: { tab: string }) {
  const { data, refresh, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const notifications = data.notifications ?? [];
  const unread = notifications.filter((n) => !n.readAt);
  const all = tab === 'all';
  const visible = all ? notifications : unread;
  async function change(notification: MentionNotification, read: boolean, open = false) {
    if (busy) return;
    setBusy(true);
    try {
      if (!!notification.readAt !== read)
        await patch(`/notifications/${notification.id}`, { read });
      await refresh();
      if (open) {
        const params = new URLSearchParams({ item: notification.itemId });
        if (all) params.set('tab', 'all');
        if (notification.activityId) params.set('activity', notification.activityId);
        window.location.hash = `/notifications?${params}`;
      }
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function markAllRead() {
    setBusy(true);
    try {
      await post('/notifications/read-all', {});
      await refresh();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="notifications-page" aria-labelledby="notifications-heading">
      <header className="notifications-heading">
        <div>
          <h1 id="notifications-heading">Notifications</h1>
          <p>Mentions and conversations to come back to.</p>
        </div>
        <button
          className="button"
          disabled={busy || !unread.length}
          onClick={() => void markAllRead()}
        >
          <CheckCheck size={16} />
          Mark all as read
        </button>
      </header>
      <div className="notifications-filters" aria-label="Notification filters">
        <button
          className="button ghost"
          aria-pressed={!all}
          onClick={() => navigate('notifications')}
        >
          Unread <span className="count-badge">{unread.length}</span>
        </button>
        <button
          className="button ghost"
          aria-pressed={all}
          onClick={() => navigate('notifications', undefined, 'all')}
        >
          All
        </button>
      </div>
      {visible.length ? (
        <ul
          className="notifications-list"
          aria-label={all ? 'All notifications' : 'Unread notifications'}
        >
          {visible.map((notification) => {
            const item = data.items.find((i) => i.id === notification.itemId);
            if (!item) return null;
            const actor = data.users.find((u) => u.id === notification.actorId);
            const actorName = actor?.name ?? 'A former member';
            return (
              <li
                className={`notification-row ${notification.readAt ? '' : 'unread'}`}
                key={notification.id}
              >
                <button
                  className="notification-open"
                  disabled={busy}
                  onClick={() => void change(notification, true, true)}
                >
                  <Avatar user={actor} size={32} />
                  <span className="notification-content">
                    <span>
                      <strong>{actorName}</strong> mentioned you in{' '}
                      {notification.activityId ? 'a comment' : 'a description'}
                    </span>
                    <span className="notification-item">
                      <span>{item.identifier}</span> {item.title}
                    </span>
                    <time dateTime={notification.createdAt}>
                      {new Date(notification.createdAt).toLocaleString(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </time>
                  </span>
                </button>
                <button
                  className="icon-button notification-read"
                  disabled={busy}
                  aria-label={`${notification.readAt ? 'Mark unread' : 'Mark as read'}: ${item.identifier}`}
                  title={notification.readAt ? 'Mark unread' : 'Mark as read'}
                  onClick={() => void change(notification, !notification.readAt)}
                >
                  {notification.readAt ? <Circle size={17} /> : <Check size={17} />}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="notifications-empty" role="status">
          {all ? <Bell size={30} /> : <CheckCheck size={30} />}
          <h2>{all ? 'No notifications yet' : 'You’re all caught up'}</h2>
          <p>
            When someone mentions you in a work item description or comment, you’ll see it here.
          </p>
          {!all && notifications.length > 0 && (
            <button
              className="text-button"
              onClick={() => navigate('notifications', undefined, 'all')}
            >
              View read notifications
            </button>
          )}
        </div>
      )}
    </section>
  );
}
