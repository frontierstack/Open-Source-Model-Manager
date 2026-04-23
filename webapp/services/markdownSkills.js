// Markdown skills — storage and parsing for instructional .md files the LLM
// consults when it needs to know how to do something. These are NOT executed;
// they're retrieved by the chat stream's `load_skill` tool and fed back to
// the model as tool output so it can read the procedure and then call real
// tools to carry it out.
//
// Storage layout: /models/.modelserver/skills-md/<owner>/<slug>.md
//   <owner> = user id for user-scoped skills, or "global" for admin-created
//             skills visible to everyone.
//   <slug>  = kebab-cased filename derived from the skill's name; uniqueness
//             is enforced per-owner.
//
// File format (YAML-ish frontmatter, only flat string keys supported; we do
// not pull in a full YAML parser since we don't need lists/nested maps here):
//
//   ---
//   name: github-repo-research
//   description: How to gather info on a GitHub repository
//   triggers: github, repo, repository
//   ---
//
//   # Body in standard markdown

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKILLS_DIR = process.env.MARKDOWN_SKILLS_DIR
    || '/models/.modelserver/skills-md';

const FRONTMATTER_FENCE = '---';
const MAX_BODY_BYTES = 256 * 1024;       // 256 KiB per skill — generous
const MAX_FIELD_LEN = 512;               // frontmatter field length cap

// Ensure the root dir exists on first use; cheap and synchronous so startup
// logs show the path.
function ensureRoot() {
    if (!fsSync.existsSync(SKILLS_DIR)) {
        fsSync.mkdirSync(SKILLS_DIR, { recursive: true, mode: 0o755 });
    }
}
ensureRoot();

// --- Frontmatter parser ----------------------------------------------------

function parseFrontmatter(text) {
    if (typeof text !== 'string') return { meta: {}, body: '' };
    const lines = text.split(/\r?\n/);
    if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
        // No frontmatter — treat whole file as body
        return { meta: {}, body: text };
    }
    const meta = {};
    let i = 1;
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === FRONTMATTER_FENCE) { i++; break; }
        const m = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
        if (m) {
            let value = m[2].trim();
            // Strip surrounding quotes if present
            if ((value.startsWith('"') && value.endsWith('"'))
                || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            meta[m[1]] = value.slice(0, MAX_FIELD_LEN);
        }
    }
    const body = lines.slice(i).join('\n').replace(/^\n+/, '');
    return { meta, body };
}

function serializeFrontmatter(meta, body) {
    const keys = ['name', 'description', 'triggers'];
    const out = [FRONTMATTER_FENCE];
    for (const k of keys) {
        if (meta[k] != null && meta[k] !== '') {
            // Simple scalar rendering; escape only the line-break case.
            const v = String(meta[k]).replace(/\r?\n/g, ' ').slice(0, MAX_FIELD_LEN);
            out.push(`${k}: ${v}`);
        }
    }
    out.push(FRONTMATTER_FENCE, '', body || '');
    return out.join('\n');
}

// --- Slug / id helpers -----------------------------------------------------

function slugify(name) {
    return (name || '')
        .toLowerCase()
        .replace(/[^\w\s-]+/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 64);
}

function ownerDir(owner) {
    const safe = owner === null || owner === undefined
        ? 'global'
        : String(owner).replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(SKILLS_DIR, safe);
}

function filePath(owner, slug) {
    const safeSlug = slug.replace(/[^A-Za-z0-9_-]/g, '');
    return path.join(ownerDir(owner), `${safeSlug}.md`);
}

async function ensureOwnerDir(owner) {
    const dir = ownerDir(owner);
    await fs.mkdir(dir, { recursive: true, mode: 0o755 });
    return dir;
}

// --- Public API ------------------------------------------------------------

/**
 * List skills visible to a user: their own skills plus all "global" skills.
 * Returns metadata only (no body) to keep list responses small.
 */
async function listSkills(userId) {
    const result = [];
    const owners = new Set();
    owners.add('global');
    if (userId) owners.add(String(userId));

    for (const owner of owners) {
        const dir = ownerDir(owner);
        let entries;
        try { entries = await fs.readdir(dir); }
        catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        for (const entry of entries) {
            if (!entry.endsWith('.md')) continue;
            const slug = entry.slice(0, -3);
            try {
                const text = await fs.readFile(path.join(dir, entry), 'utf8');
                const { meta, body } = parseFrontmatter(text);
                result.push({
                    id: slug,
                    owner: owner === 'global' ? null : owner,
                    name: meta.name || slug,
                    description: meta.description || '',
                    triggers: meta.triggers || '',
                    bodyPreview: body.slice(0, 240),
                    bodyBytes: Buffer.byteLength(body, 'utf8'),
                });
            } catch (e) {
                // Skip unreadable files but don't crash the list.
                continue;
            }
        }
    }

    // User skills shadow globals if same id — return user version.
    const deduped = new Map();
    for (const s of result) {
        const prev = deduped.get(s.id);
        if (!prev || (prev.owner == null && s.owner != null)) deduped.set(s.id, s);
    }
    return [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read one skill. Looks in the user's own folder first, then global.
 * Returns null when not found.
 */
async function getSkill(userId, id) {
    const slug = id.replace(/[^A-Za-z0-9_-]/g, '');
    const candidates = [];
    if (userId) candidates.push(String(userId));
    candidates.push('global');

    for (const owner of candidates) {
        const p = filePath(owner, slug);
        try {
            const text = await fs.readFile(p, 'utf8');
            const { meta, body } = parseFrontmatter(text);
            return {
                id: slug,
                owner: owner === 'global' ? null : owner,
                name: meta.name || slug,
                description: meta.description || '',
                triggers: meta.triggers || '',
                body,
            };
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }
    }
    return null;
}

/**
 * Create a new skill. Returns { id } on success, throws on validation or
 * collision.
 */
async function createSkill(userId, { name, description, triggers, body }) {
    if (!name || typeof name !== 'string' || !name.trim()) {
        throw new Error('name is required');
    }
    const slug = slugify(name) || crypto.randomBytes(4).toString('hex');
    const owner = userId ? String(userId) : 'global';
    await ensureOwnerDir(owner);
    const p = filePath(owner, slug);
    try {
        await fs.access(p);
        throw new Error(`A skill named "${name}" already exists (id "${slug}")`);
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
    if (body && Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        throw new Error(`Body exceeds ${MAX_BODY_BYTES} byte limit`);
    }
    const text = serializeFrontmatter(
        { name: name.trim(), description, triggers },
        body || '',
    );
    await fs.writeFile(p, text, 'utf8');
    return { id: slug, owner: userId ? String(userId) : null };
}

/**
 * Update an existing skill. Only the owner (or a null-owner admin edit on a
 * global skill) may modify. Rejects cross-owner writes.
 */
async function updateSkill(userId, id, { name, description, triggers, body }) {
    const existing = await getSkill(userId, id);
    if (!existing) throw new Error('not_found');
    if (existing.owner && existing.owner !== String(userId)) {
        throw new Error('forbidden');
    }
    if (body != null && Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        throw new Error(`Body exceeds ${MAX_BODY_BYTES} byte limit`);
    }
    const owner = existing.owner || 'global';
    const p = filePath(owner, id);
    const text = serializeFrontmatter(
        {
            name: name != null ? String(name).trim() : existing.name,
            description: description != null ? description : existing.description,
            triggers: triggers != null ? triggers : existing.triggers,
        },
        body != null ? body : existing.body,
    );
    await fs.writeFile(p, text, 'utf8');
    return { id, owner: existing.owner };
}

async function deleteSkill(userId, id) {
    const existing = await getSkill(userId, id);
    if (!existing) throw new Error('not_found');
    if (existing.owner && existing.owner !== String(userId)) {
        throw new Error('forbidden');
    }
    const owner = existing.owner || 'global';
    await fs.unlink(filePath(owner, id));
    return true;
}

module.exports = {
    parseFrontmatter,
    serializeFrontmatter,
    slugify,
    listSkills,
    getSkill,
    createSkill,
    updateSkill,
    deleteSkill,
    SKILLS_DIR,
};
