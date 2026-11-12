/**
 * A character file the person chose: who she is and what adding her would
 * do, as the daemon previews it, or why she cannot be added from it. Adding
 * her opens her page; Cancel goes back where the file was chosen from.
 */
import {
  Cell,
  Face,
  FileButton,
  Group,
  Label,
  PageHeader,
  Tile,
} from './settings-controls.tsx';
import type {Ctx} from './settings-fields.tsx';
import {
  comesWithOf,
  offerOf,
  readinessOf,
  type CharacterPreview,
} from './settings-model.ts';
import {characterFileTypes} from './settings.ts';
import type {SettingsPage} from './store.ts';

type Adding = Extract<SettingsPage, {kind: 'add'}>;

export function AddPage({
  ctx,
  page,
}: {
  readonly ctx: Ctx;
  readonly page: Adding;
}) {
  const {session} = ctx;
  const {preview} = page;
  const cancel = (
    <button
      type="button"
      className="button-large"
      onClick={() => {
        session.goTo(page.from);
      }}
    >
      Cancel
    </button>
  );

  if (preview.status === 'refused') {
    return (
      <>
        <div className="preview-top">
          <PageHeader
            art={<Tile icon="doc" tint="gray" size="page" />}
            title={page.fileName}
          />
        </div>
        <p className="page-problem" role="alert">
          {preview.message}
        </p>
        <div className="actions">
          <FileButton
            className="button-large button-default"
            accept={characterFileTypes}
            onChoose={file => {
              void session.chooseCharacterFile(file);
            }}
          >
            Choose Another File
          </FileButton>
          {cancel}
        </div>
      </>
    );
  }

  const offer = offerOf(preview);

  return (
    <>
      <div className="preview-top">
        <PageHeader
          art={
            <Face id={preview.id} name={preview.displayName} size="welcome" />
          }
          title={preview.displayName}
          subtitle={`Version ${preview.version} · ${page.fileName}`}
        />
        {preview.about === undefined ? null : (
          <p className="preview-about">{preview.about}</p>
        )}
      </div>
      <ComesWith ctx={ctx} preview={preview} />
      <Readiness ctx={ctx} />
      <div className="preview-end">
        {offer.line === undefined ? null : (
          <p className="page-note">
            {offer.line}
            {offer.link === undefined ? null : (
              <>
                {' '}
                <button
                  type="button"
                  className="status-link"
                  onClick={() => {
                    session.goTo({kind: 'character', characterId: preview.id});
                  }}
                >
                  {offer.link}
                </button>
              </>
            )}
          </p>
        )}
        <div className="actions">
          {offer.button === undefined ? null : (
            <button
              type="button"
              className="button-large button-default"
              onClick={() => {
                void session.addCharacter();
              }}
            >
              {offer.button}
            </button>
          )}
          {cancel}
        </div>
        {page.problem === undefined ? null : (
          <p className="page-problem" role="alert">
            {page.problem}
          </p>
        )}
      </div>
    </>
  );
}

/** What she comes with: a chip for each feature, and a plain line for what this app does not have. */
function ComesWith({
  ctx,
  preview,
}: {
  readonly ctx: Ctx;
  readonly preview: CharacterPreview;
}) {
  const {chips, lacking} = comesWithOf(ctx.settings, preview.comesWith);

  return chips.length === 0 && lacking === undefined ? null : (
    <section className="group chips-group">
      <h3 className="group-title">She Comes With</h3>
      <div className="chips">
        {chips.map(chip => (
          <span className="chip" key={chip.id}>
            <Tile icon={chip.icon} tint={chip.tint} size="chip" />
            {chip.name}
          </span>
        ))}
      </div>
      {lacking === undefined ? null : <p className="group-footer">{lacking}</p>}
      <p className="group-footer">
        You can change these on her page after she arrives.
      </p>
    </section>
  );
}

/** What she would find set up: the AI model, and each account set up once for everyone. */
function Readiness({ctx}: {readonly ctx: Ctx}) {
  const rows = readinessOf(ctx.settings);

  return rows.length === 0 ? null : (
    <Group footer="She thinks with your AI model. Long-term memory works once it is set up.">
      {rows.map(row => (
        <Cell key={row.label}>
          <Label name={row.label} />
          <span className="value">{row.value}</span>
        </Cell>
      ))}
    </Group>
  );
}
