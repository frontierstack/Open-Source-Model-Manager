const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const { getUserByUsername, getUserById } = require('./users');

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
            const user = await getUserByUsername(username);

            if (!user) {
                return done(null, false, { message: 'Login failed' });
            }

            // Check if user account is pending (hasn't completed registration)
            if (user.status === 'pending') {
                return done(null, false, { message: 'Account registration incomplete. Please complete your registration.' });
            }

            // Check if user is disabled
            if (user.status === 'disabled') {
                return done(null, false, { message: 'Account is disabled' });
            }

            // Compare provided password with stored hash
            const isMatch = await bcrypt.compare(password, user.passwordHash);

            if (isMatch) {
                return done(null, user);
            } else {
                return done(null, false, { message: 'Login failed' });
            }
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
    passport.deserializeUser(async (id, done) => {
        try {
            const user = await getUserById(id);
            done(null, user);
        } catch (error) {
            done(error);
        }
    });
}

module.exports = initialize;
