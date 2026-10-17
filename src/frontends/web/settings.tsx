import type {
  ConfigTarget,
  GatewayHealth,
  RuntimeConfigDiagnostic,
  RuntimeConfigFieldInspectShape,
  RuntimeConfigSectionInspectShape,
} from '../../gateway/api/index.ts';
import type {Session} from './session.ts';
import {
  connectorPresenceSentence,
  hostFieldKey,
  readableName,
  screenDiagnostics,
  sectionDiagnostics,
  sectionFieldKey,
  sectionKey,
  valueText,
} from './settings.ts';
import {characterName, type SettingsPage, type WebState} from './store.ts';
import {StatePill} from './thread.tsx';

/** What every row needs of the screen it is on. */
type RowContext = {
  readonly page: SettingsPage;
  readonly session: Session;
  readonly scope: ConfigTarget['scope'];
  /** A change is on its way, or the address will never take one. */
  readonly busy: boolean;
  readonly health: GatewayHealth | undefined;
};

/**
 * One screen for both scopes: the home's settings, or one character's.
 * Every row is the field shape the view carries, rendered by its type;
 * the screen holds no document and works out no value of its own.
 */
export function SettingsScreen({
  state,
  page,
  session,
}: {
  readonly state: WebState;
  readonly page: SettingsPage;
  readonly session: Session;
}) {
  const {target, view} = page;
  const character =
    target.scope === 'character'
      ? state.health?.characters.find(
          summary => summary.id === target.characterId,
        )
      : undefined;
  const title =
    target.scope === 'global'
      ? 'Settings · Home'
      : `Settings · ${characterName(state, target.characterId)}`;
  const context: RowContext = {
    page,
    session,
    scope: target.scope,
    busy: page.saving !== undefined || state.connection.status === 'refused',
    health: state.health,
  };
  const groups = Object.groupBy(
    view?.status === 'ok' ? view.sections : [],
    section => section.namespace,
  );

  return (
    <section className="settings" aria-label={title}>
      <header className="settings-header">
        <h2 className="settings-title">{title}</h2>
        {character === undefined ? null : <StatePill character={character} />}
        <button
          type="button"
          className="secondary"
          onClick={() => {
            session.closeSettings();
          }}
        >
          Chat
        </button>
      </header>
      <div className="settings-body">
        {page.setup ? (
          <div className="setup">
            <h3 className="setup-title">Set up your home</h3>
            <p className="setup-text">
              Choose how your character thinks and paste the key it needs, say
              what to call you, then open the chat. Every character starts from
              these.
            </p>
          </div>
        ) : null}
        {view === undefined ? (
          <p className="muted">Loading…</p>
        ) : view.status === 'refused' ? (
          <p className="banner banner-warning" role="alert">
            {view.message}
          </p>
        ) : (
          <>
            <Diagnostics diagnostics={screenDiagnostics(view)} />
            <h3 className="group-title">Host</h3>
            {view.project02.map(field => (
              <FieldRow
                key={field.name}
                fieldKey={hostFieldKey(field.name)}
                field={field}
                context={context}
              />
            ))}
            <h3 className="group-title">Plugins</h3>
            {groups.plugins === undefined ? (
              <p className="muted">No plugins are installed.</p>
            ) : (
              groups.plugins.map(section => (
                <SectionBlock
                  key={section.id}
                  section={section}
                  diagnostics={sectionDiagnostics(view, section)}
                  context={context}
                />
              ))
            )}
            <h3 className="group-title">Messaging apps</h3>
            {groups.connectors?.map(section => (
              <SectionBlock
                key={section.id}
                section={section}
                diagnostics={sectionDiagnostics(view, section)}
                context={context}
              />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function Diagnostics({
  diagnostics,
}: {
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
}) {
  return (
    <>
      {diagnostics.map((diagnostic, problem) => (
        // Two fields can fail the same way, so the banner names the path.
        <p
          className={`banner ${diagnostic.severity === 'error' ? 'banner-warning' : 'muted'}`}
          key={problem}
        >
          {diagnostic.path === undefined
            ? diagnostic.message
            : `${diagnostic.path}: ${diagnostic.message}`}
        </p>
      ))}
    </>
  );
}

/** Where a row's value comes from, as the view says it. */
function whereText(
  field: RuntimeConfigFieldInspectShape,
  scope: ConfigTarget['scope'],
): string {
  if (field.authored.configured) {
    return scope === 'global' ? 'the home' : 'this character';
  }

  if (field.effectiveSource === 'global') {
    return "from the home's settings";
  }

  return `default: ${field.effective.value === undefined ? 'none' : valueText(field, field.effective.value)}`;
}

function FieldRow({
  fieldKey,
  field,
  context,
}: {
  readonly fieldKey: string;
  readonly field: RuntimeConfigFieldInspectShape;
  readonly context: RowContext;
}) {
  const {page, session, scope, busy} = context;
  const name = readableName(field.name);
  const edit = page.edits.get(fieldKey);
  const problem = page.problems.get(fieldKey);
  const saved = page.saved === fieldKey;
  const current = valueText(field, field.effective.value);
  const shown = edit ?? current;
  const change = (text: string): void => {
    session.editSetting(fieldKey, text);
  };
  const save = (): void => {
    void session.saveSetting(fieldKey);
  };
  const reset = (): void => {
    void session.resetSetting(fieldKey);
  };

  return (
    <div className="field" data-field={fieldKey}>
      <span className="field-name">{name}</span>
      <p className="field-meta muted small">
        {field.name} · {whereText(field, scope)}
        {field.required ? ' · required' : ''}
        {field.reloadRequired ? '' : ' · applies at once'}
      </p>
      <p className="field-description small">{field.description}</p>
      <div className="field-control">
        <FieldControl
          field={field}
          name={name}
          shown={shown}
          edit={edit}
          busy={busy}
          onChange={change}
          onSave={save}
        />
        {field.valueType === 'boolean' ? null : (
          <button
            type="button"
            disabled={busy || edit === undefined}
            onClick={save}
          >
            {saved ? 'Saved' : field.secret ? 'Replace' : 'Save'}
          </button>
        )}
        {/* A required field always holds a value: the daemon refuses to unset one, so the row does not offer it. */}
        {field.authored.configured && !field.required ? (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={reset}
          >
            {field.secret ? 'Clear' : 'Reset'}
          </button>
        ) : null}
        {field.valueType === 'boolean' && saved ? (
          <span className="saved small">Saved</span>
        ) : null}
      </div>
      {problem === undefined ? null : (
        <p className="field-problem small" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

function SectionBlock({
  section,
  diagnostics,
  context,
}: {
  readonly section: RuntimeConfigSectionInspectShape;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly context: RowContext;
}) {
  const {page, session, scope, busy, health} = context;
  const key = sectionKey(section.namespace, section.id);
  const authoredHere =
    section.enabledSource === (scope === 'global' ? 'global' : 'character');
  const where =
    section.enabledSource === 'default'
      ? 'default'
      : authoredHere
        ? scope === 'global'
          ? 'the home'
          : 'this character'
        : "from the home's settings";
  // Activation is a per-character decision, so only a character's screen
  // shows how the plan judged it and why.
  const activation = scope === 'character' ? section.activation : undefined;
  const presence =
    section.namespace === 'connectors'
      ? connectorPresenceSentence(health, section.id)
      : undefined;

  return (
    <div className="section" data-section={key}>
      <div className="section-header">
        <h4 className="section-name">
          {section.displayName}{' '}
          <span className="muted small">
            {section.id} · {section.version}
          </span>
        </h4>
        {activation === undefined ? null : (
          <span className={`pill pill-${activation.status}`}>
            {activation.status}
          </span>
        )}
        {presence === undefined ? null : (
          <span className="muted small">{presence}</span>
        )}
      </div>
      <div className="field" data-field={key}>
        <span className="field-name">Enabled</span>
        <p className="field-meta muted small">
          {where}
          {activation === undefined || activation.reasons.length === 0
            ? ''
            : ` · ${activation.reasons.join(', ')}`}
          {scope === 'global'
            ? ' · Characters that set their own switch keep it'
            : ''}
        </p>
        <div className="field-control">
          <input
            type="checkbox"
            aria-label={`${section.displayName} enabled`}
            checked={
              page.edits.get(key) === undefined
                ? section.enabled
                : page.edits.get(key) === 'true'
            }
            disabled={busy}
            onChange={event => {
              session.editSetting(key, String(event.currentTarget.checked));
              void session.saveSetting(key);
            }}
          />
          {authoredHere ? (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                void session.resetSetting(key);
              }}
            >
              Reset
            </button>
          ) : null}
          {page.saved === key ? (
            <span className="saved small">Saved</span>
          ) : null}
        </div>
        {page.problems.get(key) === undefined ? null : (
          <p className="field-problem small" role="alert">
            {page.problems.get(key)}
          </p>
        )}
      </div>
      {section.fields.map(field => (
        <FieldRow
          key={field.name}
          fieldKey={sectionFieldKey(section.namespace, section.id, field.name)}
          field={field}
          context={context}
        />
      ))}
      <Diagnostics diagnostics={diagnostics} />
    </div>
  );
}

/** The box a value is typed in, by the field's kind; a secret never shows its value. */
function FieldControl({
  field,
  name,
  shown,
  edit,
  busy,
  onChange,
  onSave,
}: {
  readonly field: RuntimeConfigFieldInspectShape;
  readonly name: string;
  readonly shown: string;
  readonly edit: string | undefined;
  readonly busy: boolean;
  readonly onChange: (text: string) => void;
  readonly onSave: () => void;
}) {
  if (field.secret) {
    return (
      <>
        <span className="field-value">
          {field.effective.source === 'missing' ? 'not set' : 'set'}
        </span>
        <input
          type="password"
          aria-label={name}
          placeholder="New value"
          value={edit ?? ''}
          autoComplete="off"
          onChange={event => {
            onChange(event.currentTarget.value);
          }}
        />
      </>
    );
  }

  if (field.valueType === 'boolean') {
    return (
      <input
        type="checkbox"
        aria-label={name}
        // What was just flipped shows at once; the view says the rest. A
        // field nothing has set and that has no default is neither on nor
        // off here, and a click decides it.
        checked={
          edit !== undefined ? edit === 'true' : field.effective.value === true
        }
        ref={box => {
          if (box !== null) {
            box.indeterminate =
              edit === undefined && field.effective.value === undefined;
          }
        }}
        disabled={busy}
        onChange={event => {
          // A switch is its own save: one field, one operation.
          onChange(String(event.currentTarget.checked));
          onSave();
        }}
      />
    );
  }

  if (field.allowedValues !== undefined) {
    return (
      <select
        aria-label={name}
        value={shown}
        onChange={event => {
          onChange(event.currentTarget.value);
        }}
      >
        <option value="">—</option>
        {field.allowedValues.map(allowed => (
          <option key={allowed} value={allowed}>
            {allowed}
          </option>
        ))}
      </select>
    );
  }

  if (
    field.valueType === 'object' ||
    field.valueType === 'array' ||
    field.valueType === undefined
  ) {
    return (
      <textarea
        aria-label={name}
        rows={3}
        value={shown}
        onChange={event => {
          onChange(event.currentTarget.value);
        }}
      />
    );
  }

  return (
    <input
      type="text"
      aria-label={name}
      inputMode={field.valueType === 'number' ? 'decimal' : undefined}
      value={shown}
      autoComplete="off"
      onChange={event => {
        onChange(event.currentTarget.value);
      }}
    />
  );
}
