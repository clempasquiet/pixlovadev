//! Base SQLite locale (NAT-007, NAT-015).
//!
//! Migrations **additives uniquement** : une version plus ancienne de l’agent peut relire
//! une base migrée par une version plus récente, sauf si une migration relève
//! `min_reader_level` (aucune en V1). Une copie de la base est prise avant toute
//! migration pour permettre la restauration contrôlée d’un retour arrière.

use rusqlite::{Connection, OptionalExtension, params};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

/// Niveau de lecture de cette version de l’agent.
pub const READER_LEVEL: i64 = 1;

struct Migration {
    version: i64,
    /// Niveau minimal d’agent capable de lire la base après cette migration.
    min_reader_level: i64,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        min_reader_level: 1,
        sql: r#"
CREATE TABLE installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE association (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  registration_id TEXT,
  poll_secret TEXT,
  pairing_code TEXT,
  pairing_expires_at TEXT,
  organization_id TEXT,
  player_id TEXT,
  paired_at TEXT,
  revoked_at TEXT
);
CREATE TABLE displays (
  display_id TEXT PRIMARY KEY,
  assignment_generation TEXT NOT NULL,
  assigned INTEGER NOT NULL DEFAULT 1,
  output_key TEXT,
  name TEXT,
  width INTEGER,
  height INTEGER,
  orientation INTEGER,
  timezone TEXT,
  current_manifest TEXT,
  previous_manifest TEXT,
  staging_manifest TEXT,
  highest_version TEXT,
  highest_hash TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE manifests (
  manifest_id TEXT PRIMARY KEY,
  display_id TEXT NOT NULL,
  version TEXT NOT NULL,
  assignment_generation TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  envelope TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE manifest_assets (
  manifest_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  PRIMARY KEY (manifest_id, asset_id)
);
CREATE TABLE activation_intents (
  display_id TEXT PRIMARY KEY,
  old_manifest TEXT,
  new_manifest TEXT NOT NULL,
  started_at TEXT NOT NULL
);
CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE TABLE delivery_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manifest_id TEXT NOT NULL,
  state TEXT NOT NULL,
  error_code TEXT,
  detail TEXT,
  observed_at TEXT NOT NULL
);
CREATE TABLE clock_offset (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  offset_ms INTEGER NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE TABLE updates (
  release_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  state TEXT NOT NULL,
  detail TEXT,
  updated_at TEXT NOT NULL
);
"#,
    },
    // L07 (ADR-014) : file d’événements bornée et journal durable des commandes.
    Migration {
        version: 2,
        min_reader_level: 1,
        sql: r#"
CREATE TABLE events (
  local_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  boot_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  display_id TEXT,
  assignment_generation TEXT,
  payload TEXT NOT NULL,
  droppable INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE event_losses (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  dropped INTEGER NOT NULL
);
CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  command_hash TEXT NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  ack_sent INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  result_sent INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"#,
    },
];

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("SQLite : {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error(
        "base créée par une version plus récente (niveau de lecture {0} > {READER_LEVEL}) : lecture refusée"
    )]
    TooNew(i64),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

pub type StoreResult<T> = Result<T, StoreError>;

/// Accès partagé à la connexion. Les opérations sont courtes et synchrones.
#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
    path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Association {
    pub registration_id: Option<String>,
    pub poll_secret: Option<String>,
    pub pairing_code: Option<String>,
    pub pairing_expires_at: Option<String>,
    pub organization_id: Option<String>,
    pub player_id: Option<String>,
    pub revoked_at: Option<String>,
}

impl Association {
    pub fn paired(&self) -> Option<(&str, &str)> {
        match (&self.organization_id, &self.player_id, &self.revoked_at) {
            (Some(org), Some(player), None) => Some((org, player)),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayRow {
    pub display_id: String,
    pub assignment_generation: String,
    pub assigned: bool,
    pub output_key: Option<String>,
    pub name: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub orientation: Option<i64>,
    pub timezone: Option<String>,
    pub current_manifest: Option<String>,
    pub previous_manifest: Option<String>,
    pub staging_manifest: Option<String>,
    pub highest_version: Option<String>,
    pub highest_hash: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredManifest {
    pub manifest_id: String,
    pub display_id: String,
    pub version: String,
    pub assignment_generation: String,
    pub manifest_hash: String,
    pub envelope: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetRow {
    pub asset_id: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub mime_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Intent {
    pub display_id: String,
    pub old_manifest: Option<String>,
    pub new_manifest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxEntry {
    pub id: i64,
    pub manifest_id: String,
    pub state: String,
    pub error_code: Option<String>,
    pub detail: Option<String>,
    pub observed_at: String,
}

fn meta_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT value FROM schema_meta WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .optional()
}

impl Store {
    /// Ouvre (ou crée) la base, vérifie sa compatibilité et applique les migrations.
    pub fn open(path: &Path) -> StoreResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        restrict_permissions(path);
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);",
        )?;
        let min_reader = meta_get(&conn, "min_reader_level")?.unwrap_or(0);
        if min_reader > READER_LEVEL {
            return Err(StoreError::TooNew(min_reader));
        }
        let current = meta_get(&conn, "schema_version")?.unwrap_or(0);
        let pending: Vec<&Migration> = MIGRATIONS.iter().filter(|m| m.version > current).collect();
        if !pending.is_empty() && current > 0 {
            // Copie cohérente avant migration, pour un retour arrière contrôlé (NAT-015).
            let snapshot = snapshot_path(path, current);
            let _ = std::fs::remove_file(&snapshot);
            conn.execute("VACUUM INTO ?1", [snapshot.to_string_lossy().as_ref()])?;
        }
        for migration in pending {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(migration.sql)?;
            tx.execute(
                "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?1)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                [migration.version],
            )?;
            tx.execute(
                "INSERT INTO schema_meta (key, value) VALUES ('min_reader_level', ?1)
                 ON CONFLICT (key) DO UPDATE SET value = max(value, excluded.value)",
                [migration.min_reader_level],
            )?;
            tx.commit()?;
        }
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            path: path.to_path_buf(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn schema_version(&self) -> StoreResult<i64> {
        Ok(meta_get(&self.conn(), "schema_version")?.unwrap_or(0))
    }

    // --- Installation et association ------------------------------------------------------

    /// Identifiant d’installation, créé une seule fois (PLY-003).
    pub fn installation_id(&self, now: &str) -> StoreResult<String> {
        let conn = self.conn();
        if let Some(id) = conn
            .query_row(
                "SELECT installation_id FROM installation WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?
        {
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO installation (id, installation_id, created_at) VALUES (1, ?1, ?2)",
            params![id, now],
        )?;
        Ok(id)
    }

    pub fn association(&self) -> StoreResult<Association> {
        let conn = self.conn();
        Ok(conn
            .query_row(
                "SELECT registration_id, poll_secret, pairing_code, pairing_expires_at,
                        organization_id, player_id, revoked_at
                 FROM association WHERE id = 1",
                [],
                |row| {
                    Ok(Association {
                        registration_id: row.get(0)?,
                        poll_secret: row.get(1)?,
                        pairing_code: row.get(2)?,
                        pairing_expires_at: row.get(3)?,
                        organization_id: row.get(4)?,
                        player_id: row.get(5)?,
                        revoked_at: row.get(6)?,
                    })
                },
            )
            .optional()?
            .unwrap_or(Association {
                registration_id: None,
                poll_secret: None,
                pairing_code: None,
                pairing_expires_at: None,
                organization_id: None,
                player_id: None,
                revoked_at: None,
            }))
    }

    pub fn save_registration(
        &self,
        registration_id: &str,
        poll_secret: &str,
        pairing_code: &str,
        expires_at: &str,
    ) -> StoreResult<()> {
        self.conn().execute(
            "INSERT INTO association (id, registration_id, poll_secret, pairing_code, pairing_expires_at)
             VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT (id) DO UPDATE SET registration_id = excluded.registration_id,
               poll_secret = excluded.poll_secret, pairing_code = excluded.pairing_code,
               pairing_expires_at = excluded.pairing_expires_at",
            params![registration_id, poll_secret, pairing_code, expires_at],
        )?;
        Ok(())
    }

    pub fn save_pairing(
        &self,
        organization_id: &str,
        player_id: &str,
        now: &str,
    ) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE association SET organization_id = ?1, player_id = ?2, paired_at = ?3,
               poll_secret = NULL, pairing_code = NULL, revoked_at = NULL WHERE id = 1",
            params![organization_id, player_id, now],
        )?;
        Ok(())
    }

    /// Révocation constatée (401 définitif) : plus aucune synchronisation (PROTO-003).
    pub fn mark_revoked(&self, now: &str) -> StoreResult<()> {
        self.conn()
            .execute("UPDATE association SET revoked_at = ?1 WHERE id = 1", [now])?;
        Ok(())
    }

    // --- Displays --------------------------------------------------------------------------

    fn display_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DisplayRow> {
        Ok(DisplayRow {
            display_id: row.get(0)?,
            assignment_generation: row.get(1)?,
            assigned: row.get::<_, i64>(2)? != 0,
            output_key: row.get(3)?,
            name: row.get(4)?,
            width: row.get(5)?,
            height: row.get(6)?,
            orientation: row.get(7)?,
            timezone: row.get(8)?,
            current_manifest: row.get(9)?,
            previous_manifest: row.get(10)?,
            staging_manifest: row.get(11)?,
            highest_version: row.get(12)?,
            highest_hash: row.get(13)?,
            last_error: row.get(14)?,
        })
    }

    const DISPLAY_COLUMNS: &'static str = "display_id, assignment_generation, assigned, output_key,
        name, width, height, orientation, timezone, current_manifest, previous_manifest,
        staging_manifest, highest_version, highest_hash, last_error";

    pub fn displays(&self) -> StoreResult<Vec<DisplayRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM displays ORDER BY display_id",
            Self::DISPLAY_COLUMNS
        ))?;
        let rows = stmt.query_map([], Self::display_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn display(&self, display_id: &str) -> StoreResult<Option<DisplayRow>> {
        let conn = self.conn();
        Ok(conn
            .query_row(
                &format!(
                    "SELECT {} FROM displays WHERE display_id = ?1",
                    Self::DISPLAY_COLUMNS
                ),
                [display_id],
                Self::display_from_row,
            )
            .optional()?)
    }

    /// Applique la configuration cloud. Une nouvelle génération d’affectation invalide les
    /// manifests de l’ancienne : ils ne redeviennent jamais légitimes (PROTO-013).
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_display(
        &self,
        display_id: &str,
        generation: &str,
        output_key: &str,
        name: &str,
        width: i64,
        height: i64,
        orientation: i64,
        timezone: &str,
        now: &str,
    ) -> StoreResult<bool> {
        let conn = self.conn();
        let previous: Option<String> = conn
            .query_row(
                "SELECT assignment_generation FROM displays WHERE display_id = ?1",
                [display_id],
                |row| row.get(0),
            )
            .optional()?;
        let generation_changed = previous.as_deref().is_some_and(|g| g != generation);
        conn.execute(
            "INSERT INTO displays (display_id, assignment_generation, assigned, output_key, name, width,
               height, orientation, timezone, updated_at)
             VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (display_id) DO UPDATE SET assignment_generation = excluded.assignment_generation,
               assigned = 1, output_key = excluded.output_key, name = excluded.name, width = excluded.width,
               height = excluded.height, orientation = excluded.orientation,
               timezone = excluded.timezone, updated_at = excluded.updated_at",
            params![display_id, generation, output_key, name, width, height, orientation, timezone, now],
        )?;
        if generation_changed {
            conn.execute(
                "UPDATE displays SET current_manifest = NULL, previous_manifest = NULL,
                   staging_manifest = NULL, highest_version = NULL, highest_hash = NULL
                 WHERE display_id = ?1",
                [display_id],
            )?;
            conn.execute(
                "DELETE FROM activation_intents WHERE display_id = ?1",
                [display_id],
            )?;
        }
        Ok(generation_changed)
    }

    /// Displays qui ne figurent plus dans la configuration : plus rien n’y est diffusé.
    pub fn unassign_missing(&self, keep: &[String], now: &str) -> StoreResult<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT display_id FROM displays WHERE assigned = 1")?;
        let assigned: Vec<String> = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        let removed: Vec<String> = assigned
            .into_iter()
            .filter(|id| !keep.contains(id))
            .collect();
        for id in &removed {
            conn.execute(
                "UPDATE displays SET assigned = 0, current_manifest = NULL, previous_manifest = NULL,
                   staging_manifest = NULL, updated_at = ?2 WHERE display_id = ?1",
                params![id, now],
            )?;
            conn.execute("DELETE FROM activation_intents WHERE display_id = ?1", [id])?;
        }
        Ok(removed)
    }

    pub fn set_display_error(&self, display_id: &str, error: Option<&str>) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE displays SET last_error = ?2 WHERE display_id = ?1",
            params![display_id, error],
        )?;
        Ok(())
    }

    // --- Manifests -------------------------------------------------------------------------

    pub fn insert_manifest(
        &self,
        manifest: &StoredManifest,
        assets: &[AssetRow],
        now: &str,
    ) -> StoreResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO manifests (manifest_id, display_id, version, assignment_generation,
               manifest_hash, envelope, received_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                manifest.manifest_id,
                manifest.display_id,
                manifest.version,
                manifest.assignment_generation,
                manifest.manifest_hash,
                manifest.envelope,
                now
            ],
        )?;
        for asset in assets {
            tx.execute(
                "INSERT OR IGNORE INTO manifest_assets (manifest_id, asset_id, sha256, size_bytes, mime_type)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    manifest.manifest_id,
                    asset.asset_id,
                    asset.sha256,
                    asset.size_bytes as i64,
                    asset.mime_type
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn manifest(&self, manifest_id: &str) -> StoreResult<Option<StoredManifest>> {
        let conn = self.conn();
        Ok(conn
            .query_row(
                "SELECT manifest_id, display_id, version, assignment_generation, manifest_hash, envelope
                 FROM manifests WHERE manifest_id = ?1",
                [manifest_id],
                |row| {
                    Ok(StoredManifest {
                        manifest_id: row.get(0)?,
                        display_id: row.get(1)?,
                        version: row.get(2)?,
                        assignment_generation: row.get(3)?,
                        manifest_hash: row.get(4)?,
                        envelope: row.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn manifest_assets(&self, manifest_id: &str) -> StoreResult<Vec<AssetRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT asset_id, sha256, size_bytes, mime_type FROM manifest_assets
             WHERE manifest_id = ?1 ORDER BY asset_id",
        )?;
        let rows = stmt.query_map([manifest_id], |row| {
            Ok(AssetRow {
                asset_id: row.get(0)?,
                sha256: row.get(1)?,
                size_bytes: row.get::<_, i64>(2)? as u64,
                mime_type: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Candidat accepté : `staging`, et plus haute version acceptée (anti-rejeu, PROTO-013).
    pub fn set_staging(
        &self,
        display_id: &str,
        manifest_id: &str,
        version: &str,
        hash: &str,
    ) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE displays SET staging_manifest = ?2, highest_version = ?3, highest_hash = ?4,
               last_error = NULL WHERE display_id = ?1",
            params![display_id, manifest_id, version, hash],
        )?;
        Ok(())
    }

    pub fn clear_staging(&self, display_id: &str, error: Option<&str>) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE displays SET staging_manifest = NULL, last_error = ?2 WHERE display_id = ?1",
            params![display_id, error],
        )?;
        Ok(())
    }

    // --- Activation atomique (NAT-008 étapes 7 à 9) ----------------------------------------

    pub fn begin_intent(&self, display_id: &str, new_manifest: &str, now: &str) -> StoreResult<()> {
        let conn = self.conn();
        let old: Option<String> = conn
            .query_row(
                "SELECT current_manifest FROM displays WHERE display_id = ?1",
                [display_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        conn.execute(
            "INSERT INTO activation_intents (display_id, old_manifest, new_manifest, started_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (display_id) DO UPDATE SET old_manifest = excluded.old_manifest,
               new_manifest = excluded.new_manifest, started_at = excluded.started_at",
            params![display_id, old, new_manifest, now],
        )?;
        Ok(())
    }

    pub fn intents(&self) -> StoreResult<Vec<Intent>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT display_id, old_manifest, new_manifest FROM activation_intents ORDER BY display_id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Intent {
                display_id: row.get(0)?,
                old_manifest: row.get(1)?,
                new_manifest: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Première image confirmée : previous ← current, current ← new, livraison `applied`.
    pub fn commit_activation(
        &self,
        display_id: &str,
        manifest_id: &str,
        now: &str,
    ) -> StoreResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE displays SET previous_manifest = CASE
                 WHEN current_manifest IS NOT NULL AND current_manifest <> ?2 THEN current_manifest
                 ELSE previous_manifest END,
               current_manifest = ?2,
               staging_manifest = CASE WHEN staging_manifest = ?2 THEN NULL ELSE staging_manifest END,
               last_error = NULL, updated_at = ?3
             WHERE display_id = ?1",
            params![display_id, manifest_id, now],
        )?;
        tx.execute(
            "DELETE FROM activation_intents WHERE display_id = ?1 AND new_manifest = ?2",
            params![display_id, manifest_id],
        )?;
        tx.execute(
            "INSERT INTO delivery_outbox (manifest_id, state, observed_at) VALUES (?1, 'applied', ?2)",
            params![manifest_id, now],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Activation abandonnée : l’ancien reste courant, le candidat est déclaré en échec.
    /// `retry` conserve le candidat en `staging` pour une nouvelle tentative (échec
    /// transitoire : coupure, renderer relancé) ; sinon il est écarté.
    pub fn abort_activation(
        &self,
        display_id: &str,
        manifest_id: &str,
        code: &str,
        detail: &str,
        now: &str,
        retry: bool,
    ) -> StoreResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM activation_intents WHERE display_id = ?1 AND new_manifest = ?2",
            params![display_id, manifest_id],
        )?;
        tx.execute(
            "UPDATE displays SET staging_manifest = CASE WHEN staging_manifest = ?2 AND NOT ?5
               THEN NULL ELSE staging_manifest END, last_error = ?3, updated_at = ?4
             WHERE display_id = ?1",
            params![display_id, manifest_id, code, now, retry],
        )?;
        tx.execute(
            "INSERT INTO delivery_outbox (manifest_id, state, error_code, detail, observed_at)
             VALUES (?1, 'failed', ?2, ?3, ?4)",
            params![manifest_id, code, detail, now],
        )?;
        tx.commit()?;
        Ok(())
    }

    // --- Outbox des états de livraison ----------------------------------------------------

    pub fn push_delivery(
        &self,
        manifest_id: &str,
        state: &str,
        error_code: Option<&str>,
        detail: Option<&str>,
        now: &str,
    ) -> StoreResult<()> {
        self.conn().execute(
            "INSERT INTO delivery_outbox (manifest_id, state, error_code, detail, observed_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![manifest_id, state, error_code, detail, now],
        )?;
        Ok(())
    }

    pub fn outbox(&self, limit: i64) -> StoreResult<Vec<OutboxEntry>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, manifest_id, state, error_code, detail, observed_at FROM delivery_outbox
             ORDER BY id LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |row| {
            Ok(OutboxEntry {
                id: row.get(0)?,
                manifest_id: row.get(1)?,
                state: row.get(2)?,
                error_code: row.get(3)?,
                detail: row.get(4)?,
                observed_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn ack_outbox(&self, id: i64) -> StoreResult<()> {
        self.conn()
            .execute("DELETE FROM delivery_outbox WHERE id = ?1", [id])?;
        Ok(())
    }

    // --- Blobs du cache --------------------------------------------------------------------

    pub fn record_blob(&self, sha256: &str, size: u64, now: &str) -> StoreResult<()> {
        self.conn().execute(
            "INSERT INTO blobs (sha256, size_bytes, last_used_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (sha256) DO UPDATE SET last_used_at = excluded.last_used_at",
            params![sha256, size as i64, now],
        )?;
        Ok(())
    }

    pub fn forget_blob(&self, sha256: &str) -> StoreResult<()> {
        self.conn()
            .execute("DELETE FROM blobs WHERE sha256 = ?1", [sha256])?;
        Ok(())
    }

    /// Blobs par ancienneté d’usage (candidats à l’éviction en tête).
    pub fn blobs_by_age(&self) -> StoreResult<Vec<(String, u64)>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT sha256, size_bytes FROM blobs ORDER BY last_used_at, sha256")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as u64)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Épinglage (NAT-009) : assets des manifests current, previous et staging, et des
    /// intentions en cours, de chaque Display affecté.
    pub fn pinned_blobs(&self) -> StoreResult<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT DISTINCT ma.sha256 FROM manifest_assets ma
             WHERE ma.manifest_id IN (
               SELECT current_manifest FROM displays WHERE assigned = 1
               UNION SELECT previous_manifest FROM displays WHERE assigned = 1
               UNION SELECT staging_manifest FROM displays WHERE assigned = 1
               UNION SELECT new_manifest FROM activation_intents
               UNION SELECT old_manifest FROM activation_intents)
             ORDER BY ma.sha256",
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    // --- Horloge et mises à jour -----------------------------------------------------------

    pub fn save_clock_offset(&self, offset_ms: i64, now: &str) -> StoreResult<()> {
        self.conn().execute(
            "INSERT INTO clock_offset (id, offset_ms, observed_at) VALUES (1, ?1, ?2)
             ON CONFLICT (id) DO UPDATE SET offset_ms = excluded.offset_ms,
               observed_at = excluded.observed_at",
            params![offset_ms, now],
        )?;
        Ok(())
    }

    pub fn clock_offset(&self) -> StoreResult<Option<(i64, String)>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT offset_ms, observed_at FROM clock_offset WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }

    pub fn record_update(
        &self,
        release_id: &str,
        version: &str,
        state: &str,
        detail: Option<&str>,
        now: &str,
    ) -> StoreResult<()> {
        self.conn().execute(
            "INSERT INTO updates (release_id, version, state, detail, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (release_id) DO UPDATE SET state = excluded.state, detail = excluded.detail,
               updated_at = excluded.updated_at",
            params![release_id, version, state, detail, now],
        )?;
        Ok(())
    }

    pub fn updates(&self) -> StoreResult<Vec<UpdateRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT release_id, version, state, detail FROM updates ORDER BY updated_at DESC LIMIT 20",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

/// Événement à transmettre (PROTO-019), dans l’ordre de sa production locale.
#[derive(Debug, Clone, PartialEq)]
pub struct NewEvent {
    pub event_id: String,
    pub boot_id: String,
    pub seq: u64,
    pub observed_at: String,
    pub kind: String,
    pub severity: &'static str,
    pub display_id: Option<String>,
    pub assignment_generation: Option<String>,
    pub payload: serde_json::Value,
    /// Mesure répétitive : éliminée en premier quand la file est pleine.
    pub droppable: bool,
}

/// Commande inscrite durablement (PROTO-008) : identifiant, empreinte, état local.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandRow {
    pub command_id: String,
    pub command_hash: String,
    pub kind: String,
    /// `received` (inscrite), `running` (lancée), `done` (résultat enregistré).
    pub state: String,
    pub ack_sent: bool,
    /// Résultat `CommandResult` en JSON.
    pub result: Option<String>,
    pub result_sent: bool,
    pub expires_at: String,
}

impl Store {
    // --- File d’événements (PROTO-019) ------------------------------------------------------

    /// Ajoute un événement ; au-delà de `max` événements, le plus ancien éliminable (sinon le
    /// plus ancien) est retiré et compté comme perdu.
    pub fn push_event(&self, event: &NewEvent, max: u64) -> StoreResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let count: i64 = tx.query_row("SELECT count(*) FROM events", [], |row| row.get(0))?;
        if count as u64 >= max {
            let excess = count as u64 - max + 1;
            let removed = tx.execute(
                "DELETE FROM events WHERE local_id IN (
                   SELECT local_id FROM events ORDER BY droppable DESC, local_id LIMIT ?1)",
                [excess as i64],
            )?;
            tx.execute(
                "INSERT INTO event_losses (id, dropped) VALUES (1, ?1)
                 ON CONFLICT (id) DO UPDATE SET dropped = dropped + excluded.dropped",
                [removed as i64],
            )?;
        }
        tx.execute(
            "INSERT INTO events (event_id, boot_id, seq, observed_at, type, severity, display_id,
               assignment_generation, payload, droppable)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                event.event_id,
                event.boot_id,
                event.seq as i64,
                event.observed_at,
                event.kind,
                event.severity,
                event.display_id,
                event.assignment_generation,
                event.payload.to_string(),
                event.droppable,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Prochain lot à transmettre, au format `PlayerEvent`.
    pub fn pending_events(&self, limit: u32) -> StoreResult<Vec<serde_json::Value>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT event_id, boot_id, seq, observed_at, type, severity, display_id,
               assignment_generation, payload FROM events ORDER BY local_id LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |row| {
            let payload: String = row.get(8)?;
            Ok(serde_json::json!({
                "event_id": row.get::<_, String>(0)?,
                "boot_id": row.get::<_, String>(1)?,
                "seq": row.get::<_, i64>(2)?,
                "observed_at": row.get::<_, String>(3)?,
                "type": row.get::<_, String>(4)?,
                "severity": row.get::<_, String>(5)?,
                "display_id": row.get::<_, Option<String>>(6)?,
                "assignment_generation": row.get::<_, Option<String>>(7)?,
                "payload": serde_json::from_str::<serde_json::Value>(&payload)
                    .unwrap_or_else(|_| serde_json::json!({})),
            }))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn event_count(&self) -> StoreResult<u64> {
        let count: i64 = self
            .conn()
            .query_row("SELECT count(*) FROM events", [], |row| row.get(0))?;
        Ok(count as u64)
    }

    /// Retire les événements accusés par le cloud, et seulement eux.
    pub fn ack_events(&self, event_ids: &[String]) -> StoreResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for id in event_ids {
            tx.execute("DELETE FROM events WHERE event_id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn dropped_events(&self) -> StoreResult<u64> {
        let dropped: Option<i64> = self
            .conn()
            .query_row("SELECT dropped FROM event_losses WHERE id = 1", [], |row| {
                row.get(0)
            })
            .optional()?;
        Ok(dropped.unwrap_or(0).max(0) as u64)
    }

    /// Soustrait les pertes déclarées dans un lot accusé (d’autres ont pu s’ajouter depuis).
    pub fn consume_dropped(&self, reported: u64) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE event_losses SET dropped = max(dropped - ?1, 0) WHERE id = 1",
            [reported as i64],
        )?;
        Ok(())
    }

    // --- Journal des commandes (PROTO-008) --------------------------------------------------

    /// Identifiant → empreinte des commandes déjà inscrites.
    pub fn command_hashes(&self) -> StoreResult<std::collections::HashMap<String, String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT command_id, command_hash FROM commands")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Inscrit une commande avant tout effet ; `result` est fourni pour un refus immédiat.
    pub fn record_command(&self, row: &CommandRow, now: &str) -> StoreResult<()> {
        self.conn().execute(
            "INSERT INTO commands (command_id, command_hash, type, state, ack_sent, result,
               result_sent, expires_at, received_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 0, ?5, 0, ?6, ?7, ?7)",
            params![
                row.command_id,
                row.command_hash,
                row.kind,
                row.state,
                row.result,
                row.expires_at,
                now
            ],
        )?;
        Ok(())
    }

    pub fn command(&self, command_id: &str) -> StoreResult<Option<CommandRow>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT command_id, command_hash, type, state, ack_sent, result, result_sent,
                   expires_at FROM commands WHERE command_id = ?1",
                [command_id],
                command_row,
            )
            .optional()?)
    }

    pub fn set_command_running(&self, command_id: &str, now: &str) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE commands SET state = 'running', updated_at = ?2
             WHERE command_id = ?1 AND state = 'received'",
            params![command_id, now],
        )?;
        Ok(())
    }

    pub fn finish_command(&self, command_id: &str, result: &str, now: &str) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE commands SET state = 'done', result = ?2, updated_at = ?3
             WHERE command_id = ?1 AND state <> 'done'",
            params![command_id, result, now],
        )?;
        Ok(())
    }

    pub fn mark_command_ack(&self, command_id: &str) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE commands SET ack_sent = 1 WHERE command_id = ?1",
            [command_id],
        )?;
        Ok(())
    }

    pub fn mark_result_sent(&self, command_id: &str) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE commands SET result_sent = 1 WHERE command_id = ?1",
            [command_id],
        )?;
        Ok(())
    }

    /// Commandes dans un état donné (reprise après redémarrage).
    pub fn commands_in_state(&self, state: &str) -> StoreResult<Vec<CommandRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT command_id, command_hash, type, state, ack_sent, result, result_sent,
               expires_at FROM commands WHERE state = ?1 ORDER BY received_at",
        )?;
        let rows = stmt.query_map([state], command_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// ACK et résultats encore à transmettre.
    pub fn command_outbox(&self) -> StoreResult<Vec<CommandRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT command_id, command_hash, type, state, ack_sent, result, result_sent,
               expires_at FROM commands
             WHERE (ack_sent = 0 AND state <> 'done') OR (result IS NOT NULL AND result_sent = 0)
             ORDER BY received_at LIMIT 50",
        )?;
        let rows = stmt.query_map([], command_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Oublie les commandes terminées, transmises et expirées : elles ne peuvent plus être
    /// redistribuées, la déduplication n’en a plus besoin.
    pub fn prune_commands(&self, expired_before: &str) -> StoreResult<usize> {
        Ok(self.conn().execute(
            "DELETE FROM commands WHERE state = 'done' AND result_sent = 1 AND expires_at < ?1",
            [expired_before],
        )?)
    }
}

fn command_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CommandRow> {
    Ok(CommandRow {
        command_id: row.get(0)?,
        command_hash: row.get(1)?,
        kind: row.get(2)?,
        state: row.get(3)?,
        ack_sent: row.get(4)?,
        result: row.get(5)?,
        result_sent: row.get(6)?,
        expires_at: row.get(7)?,
    })
}

/// Mise à jour enregistrée : `release_id`, version, état, détail.
pub type UpdateRow = (String, String, String, Option<String>);

pub fn snapshot_path(path: &Path, version: i64) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".pre-v{version}"));
    path.with_file_name(name)
}

#[cfg(unix)]
pub fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
pub fn restrict_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-10-01T10:00:00Z";

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("pixlova.db")).unwrap();
        (dir, store)
    }

    #[test]
    fn identifiant_d_installation_stable() {
        let (_dir, store) = store();
        let first = store.installation_id(NOW).unwrap();
        assert_eq!(store.installation_id(NOW).unwrap(), first);
        assert_eq!(store.schema_version().unwrap(), 2);
    }

    #[test]
    fn refuse_une_base_d_un_niveau_de_lecture_superieur() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pixlova.db");
        drop(Store::open(&path).unwrap());
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE schema_meta SET value = 99 WHERE key = 'min_reader_level'",
            [],
        )
        .unwrap();
        drop(conn);
        assert!(matches!(Store::open(&path), Err(StoreError::TooNew(99))));
    }

    #[test]
    fn une_nouvelle_generation_invalide_les_manifests_de_l_ancienne() {
        let (_dir, store) = store();
        store
            .upsert_display(
                "d1",
                "1",
                "HDMI-1",
                "Vitrine",
                1920,
                1080,
                0,
                "Europe/Paris",
                NOW,
            )
            .unwrap();
        store.set_staging("d1", "m1", "3", "h").unwrap();
        store.begin_intent("d1", "m1", NOW).unwrap();
        store.commit_activation("d1", "m1", NOW).unwrap();
        assert_eq!(
            store
                .display("d1")
                .unwrap()
                .unwrap()
                .current_manifest
                .as_deref(),
            Some("m1")
        );
        assert!(
            store
                .upsert_display(
                    "d1",
                    "2",
                    "HDMI-1",
                    "Vitrine",
                    1920,
                    1080,
                    0,
                    "Europe/Paris",
                    NOW
                )
                .unwrap()
        );
        let row = store.display("d1").unwrap().unwrap();
        assert_eq!(row.current_manifest, None);
        assert_eq!(row.highest_version, None);
    }

    fn event(n: u64, droppable: bool) -> NewEvent {
        NewEvent {
            event_id: format!("00000000-0000-4000-8000-{n:012}"),
            boot_id: "11111111-1111-4111-8111-111111111111".into(),
            seq: n,
            observed_at: NOW.into(),
            kind: if droppable {
                "METRIC"
            } else {
                "PLAYBACK_ERROR"
            }
            .into(),
            severity: "info",
            display_id: None,
            assignment_generation: None,
            payload: serde_json::json!({ "n": n }),
            droppable,
        }
    }

    #[test]
    fn file_d_evenements_bornee_et_accusee() {
        let (_dir, store) = store();
        store.push_event(&event(1, false), 3).unwrap();
        store.push_event(&event(2, true), 3).unwrap();
        store.push_event(&event(3, false), 3).unwrap();
        // Pleine : la mesure éliminable part d’abord, puis le plus ancien.
        store.push_event(&event(4, false), 3).unwrap();
        store.push_event(&event(5, false), 3).unwrap();
        let pending = store.pending_events(10).unwrap();
        let seqs: Vec<i64> = pending.iter().map(|e| e["seq"].as_i64().unwrap()).collect();
        assert_eq!(seqs, [3, 4, 5]);
        assert_eq!(store.dropped_events().unwrap(), 2);
        assert_eq!(pending[0]["payload"]["n"], 3);
        store
            .ack_events(&[pending[0]["event_id"].as_str().unwrap().to_owned()])
            .unwrap();
        assert_eq!(store.event_count().unwrap(), 2);
        store.consume_dropped(2).unwrap();
        assert_eq!(store.dropped_events().unwrap(), 0);
    }

    #[test]
    fn journal_des_commandes_durable() {
        let (_dir, store) = store();
        let row = CommandRow {
            command_id: "c1".into(),
            command_hash: "h1".into(),
            kind: "GET_STATUS".into(),
            state: "received".into(),
            ack_sent: false,
            result: None,
            result_sent: false,
            expires_at: "2026-10-01T10:10:00Z".into(),
        };
        store.record_command(&row, NOW).unwrap();
        assert!(
            store.record_command(&row, NOW).is_err(),
            "identifiant unique"
        );
        assert_eq!(store.command_hashes().unwrap()["c1"], "h1");
        assert_eq!(store.command_outbox().unwrap().len(), 1);
        store.mark_command_ack("c1").unwrap();
        store.set_command_running("c1", NOW).unwrap();
        assert_eq!(store.commands_in_state("running").unwrap().len(), 1);
        assert!(store.command_outbox().unwrap().is_empty());
        store.finish_command("c1", "{}", NOW).unwrap();
        assert_eq!(
            store.command_outbox().unwrap()[0].result.as_deref(),
            Some("{}")
        );
        store.mark_result_sent("c1").unwrap();
        assert_eq!(store.prune_commands("2026-10-01T10:00:00Z").unwrap(), 0);
        assert_eq!(store.prune_commands("2026-10-02T00:00:00Z").unwrap(), 1);
    }

    #[test]
    fn activation_confirmee_puis_abandonnee() {
        let (_dir, store) = store();
        store
            .upsert_display("d1", "1", "HDMI-1", "Vitrine", 1920, 1080, 0, "UTC", NOW)
            .unwrap();
        for (id, version) in [("m1", "1"), ("m2", "2")] {
            store.set_staging("d1", id, version, "h").unwrap();
            store.begin_intent("d1", id, NOW).unwrap();
            store.commit_activation("d1", id, NOW).unwrap();
        }
        let row = store.display("d1").unwrap().unwrap();
        assert_eq!(
            (
                row.current_manifest.as_deref(),
                row.previous_manifest.as_deref()
            ),
            (Some("m2"), Some("m1"))
        );
        store.set_staging("d1", "m3", "3", "h").unwrap();
        store.begin_intent("d1", "m3", NOW).unwrap();
        assert_eq!(
            store.intents().unwrap()[0].old_manifest.as_deref(),
            Some("m2")
        );
        store
            .abort_activation("d1", "m3", "PREPARATION_FAILED", "décodage", NOW, false)
            .unwrap();
        let row = store.display("d1").unwrap().unwrap();
        assert_eq!(row.current_manifest.as_deref(), Some("m2"));
        assert_eq!(row.staging_manifest, None);
        assert!(store.intents().unwrap().is_empty());
        let states: Vec<String> = store
            .outbox(10)
            .unwrap()
            .into_iter()
            .map(|e| e.state)
            .collect();
        assert_eq!(states, ["applied", "applied", "failed"]);
    }
}
