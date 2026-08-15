from pathlib import Path

original = Path('public/styles_original.css')
target = Path('public/styles.css')
text = original.read_text(encoding='utf-8')

# Restore baseline from clean copy
target.write_text(text, encoding='utf-8')

# Table of contents
toc = '''/* ============================================================
   TABLE OF CONTENTS
   1.  Design Tokens         (:root)
   2.  Reset & Base          (*, html/body, controls)
   3.  Boot / Login          (.boot-screen, .login-page)
   4.  Layout Shell          (.app-shell, .sidebar, .topbar, .content)
   5.  Shared Components     (buttons, inputs, badges, dialogs, toast)
   6.  iOS Card System       (.ios-card, .ios-chip, .ios-status)
   7.  Announcements         (.announcement-card)
   8.  Responsive            (1080 / 820 / 600 / reduced-motion)
   ============================================================ */

'''
if toc not in text:
    text = text.replace(':root {\n', toc + ':root {\n', 1)

# New design tokens
token_insert = '''  --chip-muted: #8E8E93;
  --neutral-border: #E7E1D7;
  --neutral-soft: #F2F2F7;
  --severity-critical-border: #C4612F;
  --severity-info-border: #5C9EE8;
  --severity-warning-border: #F5A623;
'''
text = text.replace('  --focus: #0b7894;\n  --shadow: ', '  --focus: #0b7894;\n' + token_insert + '  --shadow: ')

# Shared color variableization
replacements = {
    '.login-visual {\n  position: relative;\n  display: grid;\n  place-items: center;\n  overflow: hidden;\n  background: #e9efeb;\n}': '.login-visual {\n  position: relative;\n  display: grid;\n  place-items: center;\n  overflow: hidden;\n  background: var(--surface-subtle);\n}',
    '.nav-button.active {\n  background: #e1f0e8;\n  color: #153c2d;\n  font-weight: 700;\n}': '.nav-button.active {\n  background: var(--primary-soft);\n  color: var(--primary);\n  font-weight: 700;\n}',
    '.avatar {\n  width: 34px;\n  height: 34px;\n  flex: 0 0 auto;\n  display: grid;\n  place-items: center;\n  border-radius: 50%;\n  background: #dce8e0;\n  color: #244f3e;\n  font-weight: 750;\n}': '.avatar {\n  width: 34px;\n  height: 34px;\n  flex: 0 0 auto;\n  display: grid;\n  place-items: center;\n  border-radius: 50%;\n  background: var(--primary-soft);\n  color: var(--primary);\n  font-weight: 750;\n}',
    'tbody tr:hover {\n  background: #f6faf7;\n}': 'tbody tr:hover {\n  background: var(--surface-subtle);\n}',
    '.input::placeholder,\n.textarea::placeholder {\n  color: #849087;\n}': '.input::placeholder,\n.textarea::placeholder {\n  color: var(--text-muted);\n}',
    '.form-error {\n  display: none;\n  padding: 10px 12px;\n  border: 1px solid #f3b7b1;\n  border-radius: 5px;\n  background: var(--danger-soft);\n  color: var(--danger);': '.form-error {\n  display: none;\n  padding: 10px 12px;\n  border: 1px solid var(--danger-soft);\n  border-radius: 5px;\n  background: var(--danger-soft);\n  color: var(--danger);',
    '.generated-keys {\n  width: 100%;\n  min-height: 220px;\n  padding: 12px;\n  border: 1px solid var(--border);\n  border-radius: 5px;\n  background: #f6f8f6;\n  font-family: "SFMono-Regular", Consolas, monospace;\n  font-size: 0.82rem;\n  line-height: 1.7;\n  resize: vertical;\n}': '.generated-keys {\n  width: 100%;\n  min-height: 220px;\n  padding: 12px;\n  border: 1px solid var(--border);\n  border-radius: 5px;\n  background: var(--surface-subtle);\n  font-family: "SFMono-Regular", Consolas, monospace;\n  font-size: 0.82rem;\n  line-height: 1.7;\n  resize: vertical;\n}',
}
for old, new in replacements.items():
    text = text.replace(old, new, 1)

# Announcement tokens (deduplicate if script re-runs)
text = text.replace('  --announcement-active-bg: #E8F5E9;\n  --announcement-active-text: #2E7D32;\n  --announcement-critical-bg: #F2E3D6;\n  --announcement-critical-text: #C4612F;\n  --announcement-draft-bg: #F2F2F7;\n  --announcement-draft-text: #8E8E93;\n  --announcement-inactive-bg: #FFEBEE;\n  --announcement-inactive-text: #C62828;\n  --announcement-info-bg: #E3F2FD;\n  --announcement-info-text: #1976D2;\n', '')
announcement_tokens = '''  --announcement-active-bg: #E8F5E9;
  --announcement-active-text: #2E7D32;
  --announcement-critical-bg: #F2E3D6;
  --announcement-critical-text: #C4612F;
  --announcement-draft-bg: #F2F2F7;
  --announcement-draft-text: #8E8E93;
  --announcement-inactive-bg: #FFEBEE;
  --announcement-inactive-text: #C62828;
  --announcement-info-bg: #E3F2FD;
  --announcement-info-text: #1976D2;
'''
text = text.replace('  --severity-warning-border: #F5A623;\n  --shadow: ', '  --severity-warning-border: #F5A623;\n' + announcement_tokens + '  --shadow: ')

# Announcement card + severity
announcement_replacements = {
    '.announcement-card {\n  background: #ffffff;\n  border-radius: 12px;\n  padding: 16px;\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);\n  border-left: 4px solid #E7E1D7;\n  transition: box-shadow 0.2s ease;\n}': '.announcement-card {\n  background: var(--surface);\n  border-radius: 12px;\n  padding: 16px;\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);\n  border-left: 4px solid var(--neutral-border);\n  transition: box-shadow 0.2s ease;\n}',
    '.announcement-card.severity-info {\n  border-left-color: #5C9EE8;\n}': '.announcement-card.severity-info {\n  border-left-color: var(--severity-info-border);\n}',
    '.announcement-card.severity-warning {\n  border-left-color: #F5A623;\n}': '.announcement-card.severity-warning {\n  border-left-color: var(--severity-warning-border);\n}',
    '.announcement-card.severity-critical {\n  border-left-color: #C4612F;\n}': '.announcement-card.severity-critical {\n  border-left-color: var(--severity-critical-border);\n}',
    '.announcement-sequence {\n  font-size: 13px;\n  font-weight: 600;\n  color: #8E8E93;\n  font-family: \'SF Mono\', \'Menlo\', monospace;\n}': '.announcement-sequence {\n  font-size: 13px;\n  font-weight: 600;\n  color: var(--chip-muted);\n  font-family: \'SF Mono\', \'Menlo\', monospace;\n}',
    '.announcement-severity {\n  display: inline-flex;\n  align-items: center;\n  padding: 3px 10px;\n  border-radius: 12px;\n  font-size: 12px;\n  font-weight: 500;\n  background: #F2F2F7;\n  color: #1F2421;\n}': '.announcement-severity {\n  display: inline-flex;\n  align-items: center;\n  padding: 3px 10px;\n  border-radius: 12px;\n  font-size: 12px;\n  font-weight: 500;\n  background: var(--neutral-soft);\n  color: var(--text);\n}',
    '.announcement-severity.info {\n  background: #E3F2FD;\n  color: #1976D2;\n}': '.announcement-severity.info {\n  background: var(--announcement-info-bg);\n  color: var(--announcement-info-text);\n}',
    '.announcement-severity.warning {\n  background: #FFF3E0;\n  color: #E65100;\n}': '.announcement-severity.warning {\n  background: var(--announcement-warning-bg);\n  color: var(--announcement-warning-text);\n}',
    '.announcement-severity.critical {\n  background: #F2E3D6;\n  color: #C4612F;\n}': '.announcement-severity.critical {\n  background: var(--announcement-critical-bg);\n  color: var(--announcement-critical-text);\n}',
    '.announcement-placement {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  padding: 3px 10px;\n  border-radius: 12px;\n  font-size: 12px;\n  font-weight: 500;\n  background: #F2F2F7;\n  color: #6B7280;\n}': '.announcement-placement {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  padding: 3px 10px;\n  border-radius: 12px;\n  font-size: 12px;\n  font-weight: 500;\n  background: var(--neutral-soft);\n  color: var(--text-muted);\n}',
    '.announcement-status.draft {\n  background: #F2F2F7;\n  color: #8E8E93;\n}': '.announcement-status.draft {\n  background: var(--announcement-draft-bg);\n  color: var(--announcement-draft-text);\n}',
    '.announcement-status.active {\n  background: #E8F5E9;\n  color: #2E7D32;\n}': '.announcement-status.active {\n  background: var(--announcement-active-bg);\n  color: var(--announcement-active-text);\n}',
    '.announcement-status.inactive {\n  background: #FFEBEE;\n  color: #C62828;\n}': '.announcement-status.inactive {\n  background: var(--announcement-inactive-bg);\n  color: var(--announcement-inactive-text);\n}',
    '.announcement-title {\n  font-size: 17px;\n  font-weight: 600;\n  color: #1F2421;\n  margin: 0 0 8px 0;\n  line-height: 1.4;\n}': '.announcement-title {\n  font-size: 17px;\n  font-weight: 600;\n  color: var(--text);\n  margin: 0 0 8px 0;\n  line-height: 1.4;\n}',
    '.announcement-body {\n  font-size: 15px;\n  color: #5C635D;\n  line-height: 1.5;\n  margin: 0 0 12px 0;\n  white-space: pre-wrap;\n  word-wrap: break-word;\n}': '.announcement-body {\n  font-size: 15px;\n  color: var(--text-muted);\n  line-height: 1.5;\n  margin: 0 0 12px 0;\n  white-space: pre-wrap;\n  word-wrap: break-word;\n}',
    '.announcement-footer {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 12px;\n  font-size: 13px;\n  color: #8E8E93;\n  padding-top: 8px;\n  border-top: 1px solid #F2F2F7;\n}': '.announcement-footer {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 12px;\n  font-size: 13px;\n  color: var(--text-muted);\n  padding-top: 8px;\n  border-top: 1px solid var(--neutral-soft);\n}',
    '.announcement-publish-row {\n  margin-top: 12px;\n  padding-top: 12px;\n  border-top: 1px solid #F2F2F7;\n}': '.announcement-publish-row {\n  margin-top: 12px;\n  padding-top: 12px;\n  border-top: 1px solid var(--neutral-soft);\n}',
}
for old, new in announcement_replacements.items():
    text = text.replace(old, new, 1)

# Merge duplicate 768px announcement block into 820px
old_block = '''@media (max-width: 768px) {
  .announcement-card {
    padding: 12px;
  }

  .announcement-title {
    font-size: 16px;
  }

  .announcement-body {
    font-size: 14px;
  }
}'''
new_block = '''  .announcement-card {
    padding: 12px;
  }

  .announcement-title {
    font-size: 16px;
  }

  .announcement-body {
    font-size: 14px;
  }'''
text = text.replace(old_block, new_block, 1)
text = text.replace('  .announcement-body {\n    font-size: 14px;\n  }\n}\n\n@media (max-width: 600px)', '  .announcement-body {\n    font-size: 14px;\n  }\n}\n\n@media (max-width: 600px)')
text = text.replace('  .announcement-body {\n    font-size: 14px;\n  }\n}\n@media (max-width: 600px)', '  .announcement-body {\n    font-size: 14px;\n  }\n}\n\n@media (max-width: 600px)')

target.write_text(text, encoding='utf-8')
