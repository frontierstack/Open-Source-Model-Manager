const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const { getUserByUsername, getUserById } = require('./users');

// Decoy bcrypt hash used to equalize timing between "user not found" and
// "wrong password". Must be a real bcrypt hash (right format + valid salt
// rounds) — bcrypt.compare returns instantly on malformed inputs, which
// would re-introduce the timing leak. Generated via
// bcrypt.hashSync('decoy_for_timing_equalization', 10).
const DECOY_PASSWORD_HASH = '$2a$10$uVs2O5O9SU0oHC/48Sl2Oebx/9OtPJp4BovEXTEyCTIpgrmfxmWLe';

// A user is disabled if EITHER the legacy `disabled: true` flag is set, or
// the canonical `status: 'disabled'` is set. Two parallel mechanisms exist
// (PUT /api/users/:id with {disabled:true} vs PUT /api/users/:id/disable),
// so any login/session check must accept both to avoid an auth bypass where
// a user disabled via the UI button can still authenticate.
function isDisabled(user) {
    return user && (user.disabled === true || user.status === 'disabled');
}

/**
 * Configure Passport.js for local authentication strategy
 * Supports username/password authentication with bcrypt hashing
 *
 * @param {Object} passport - Passport instance
 */
function initialize(passport) {
    // Authenticate user with username and password
    const authenticateUser = async (username, password, done) => {
        try {
            // Reject non-string username up front to avoid TypeError on
            // .toLowerCase() inside the user lookup.
            if (typeof username !== 'string' || typeof password !== 'string') {
                // Still run a bcrypt comparison so timing matches the
                // happy-path branch — keeps automated probes from
                // distinguishing type-confusion attempts.
                await bcrypt.compare('decoy', DECOY_PASSWORD_HASH);
                return done(null, false, { message: 'Login failed' });
            }

            const user = await getUserByUsername(username);

            // Always run bcrypt — against the real hash if the user exists,
            // against a decoy if it doesn't — so attackers can't enumerate
            // valid usernames by response timing.
            const hashToCompare = (user && user.passwordHash) || DECOY_PASSWORD_HASH;
            const isMatch = await bcrypt.compare(password, hashToCompare);

            // All failure paths return the SAME generic message — we never
            // disclose whether the account exists, is pending, or is
            // disabled. Disclosing any of those gives an attacker free
            // confirmation of a username and can encourage targeted
            // brute-force attempts.
            if (!user || user.status === 'pending' || isDisabled(user) || !isMatch || !user.passwordHash) {
                return done(null, false, { message: 'Login failed' });
            }

            return done(null, user);
        } catch (error) {
            return done(error);
        }
    };

    // Configure local strategy
    passport.use(new LocalStrategy(
        { usernameField: 'username' },
        authenticateUser
    ));

    // Serialize user for session
    // Only store user ID in session to minimize session size
    passport.serializeUser((user, done) => {
        done(null, user.id);
    });

    // Deserialize user from session
    // Retrieve full user object from ID stored in session
    // Also checks if user has been disabled - boots them out if so
    passport.deserializeUser(async (id, done) => {
        try {
            const user = await getUserById(id);

            // If user not found or has been disabled, invalidate session
            if (!user || isDisabled(user)) {
                return done(null, false);
            }

            done(null, user);
        } catch (error) {
            done(error);
        }
    });
}

module.exports = initialize;
module.exports.isDisabled = isDisabled;
