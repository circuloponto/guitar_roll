export default function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-message">{message}</div>
        <div className="confirm-actions">
          <button className="settings-btn" onClick={onCancel}>Cancel</button>
          <button className="settings-btn confirm-danger" onClick={onConfirm}>Confirm</button>
        </div>
      </div>
    </div>
  );
}
