import { randomBytes, randomInt, createHash, timingSafeEqual, scrypt as scryptCallback } from "crypto";
import { promisify } from "util";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import nodemailer from "nodemailer";

const router = express.Router();
const scrypt = promisify(scryptCallback);
const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, trim: true, unique: true, minlength: 3, maxlength: 24 },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    password: { type: String, required: true, select: false },
    isVerified: { type: Boolean, default: false }
}, { timestamps: true });

const sessionSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: "CodemonUser", required: true },
    refreshToken: { type: String, required: true, unique: true },
    isValid: { type: Boolean, default: true },
    userAgent: { type: String, default: null },
    ipAddress: { type: String, default: null },
    expiresAt: { type: Date, required: true }
}, { timestamps: true });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const otpSchema = new mongoose.Schema({
    email: { type: String, required: true, lowercase: true, index: true },
    otp: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now, expires: 300 }
});

const User = mongoose.models.CodemonUser || mongoose.model("CodemonUser", userSchema, "users");
const Session = mongoose.models.CodemonSession || mongoose.model("CodemonSession", sessionSchema, "sessions");
const Otp = mongoose.models.CodemonOtp || mongoose.model("CodemonOtp", otpSchema, "otps");

let databaseConnection;
let mailTransport;

function getJwtSecret() {
    const secret = process.env.JWT_SECRET || process.env.JWT_SECRETS;
    if (!secret) {
        const error = new Error("Authentication is not configured: set JWT_SECRET.");
        error.status = 503;
        throw error;
    }
    if (secret.length < 32) {
        const error = new Error("JWT_SECRET must be at least 32 characters long.");
        error.status = 503;
        throw error;
    }
    return secret;
}

export async function ensureAuthDatabase() {
    if (!process.env.MONGO_URI) {
        const error = new Error("Authentication is not configured: set MONGO_URI.");
        error.status = 503;
        throw error;
    }
    if (mongoose.connection.readyState === 1) return;
    if (mongoose.connection.readyState === 0) databaseConnection = null;

    if (!databaseConnection) {
        databaseConnection = mongoose.connect(process.env.MONGO_URI, {
            serverSelectionTimeoutMS: 5000
        }).catch((cause) => {
            databaseConnection = null;
            const error = new Error("Authentication database is unavailable.");
            error.status = 503;
            error.cause = cause;
            throw error;
        });
    }
    await databaseConnection;
}

export function verifyAccessToken(token) {
    const claims = jwt.verify(token, getJwtSecret());
    if (!claims.userId || !claims.username || !claims.email) {
        throw new Error("Invalid access token");
    }
    return claims;
}

export function requireAccessToken(req, res, next) {
    const authorization = req.get("authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) return res.status(401).json({ message: "Sign in to continue." });

    try {
        req.authUser = verifyAccessToken(token);
        return next();
    } catch {
        return res.status(401).json({ message: "Your session has expired. Sign in again." });
    }
}

function getSafeUser(user) {
    return {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        isVerified: user.isVerified
    };
}

function hashOtp(otp) {
    return createHash("sha256").update(otp).digest("hex");
}

function isOtpMatch(savedOtp, submittedOtp) {
    const expected = Buffer.from(savedOtp);
    const actual = Buffer.from(hashOtp(submittedOtp));
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return true;
    return expected.toString() === submittedOtp;
}

async function hashPassword(password) {
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, 64);
    return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
    const [scheme, saltHex, hashHex] = storedHash.split(":");
    if (scheme === "scrypt" && saltHex && hashHex) {
        const expected = Buffer.from(hashHex, "hex");
        const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
        return expected.length === actual.length && timingSafeEqual(expected, actual);
    }

    // Upgrade password hashes produced by the supplied Auth service after successful login.
    if (/^[a-f\d]{64}$/i.test(storedHash)) {
        const legacyHash = createHash("sha256").update(password).digest();
        const expected = Buffer.from(storedHash, "hex");
        return expected.length === legacyHash.length && timingSafeEqual(expected, legacyHash);
    }
    return false;
}

function createMailTransport() {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        const error = new Error("Email verification is not configured: set EMAIL_USER and EMAIL_PASS.");
        error.status = 503;
        throw error;
    }
    if (!mailTransport) {
        mailTransport = nodemailer.createTransport({
            service: "gmail",
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });
    }
    return mailTransport;
}

async function sendOtp(email, otp) {
    await createMailTransport().sendMail({
        from: `"Codemon" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "Your Codemon verification code",
        text: `Your Codemon verification code is ${otp}. It expires in 5 minutes.`,
        html: `<p>Your Codemon verification code is <strong>${otp}</strong>.</p><p>It expires in 5 minutes.</p>`
    });
}

async function issueOtp(email) {
    const previousOtp = await Otp.findOne({ email }).sort({ createdAt: -1 });
    if (previousOtp && Date.now() - previousOtp.createdAt.getTime() < 30_000) {
        const error = new Error("Please wait before requesting another verification code.");
        error.status = 429;
        throw error;
    }
    const otp = randomInt(0, 1_000_000).toString().padStart(6, "0");
    await Otp.deleteMany({ email });
    await Otp.create({ email, otp: hashOtp(otp) });
    try {
        await sendOtp(email, otp);
    } catch (error) {
        await Otp.deleteMany({ email });
        const mailError = new Error("Could not send the verification email. Please try again later.");
        mailError.status = 503;
        mailError.cause = error;
        throw mailError;
    }
}

function setRefreshCookie(res, refreshToken) {
    res.cookie("refreshToken", refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/api/auth",
        maxAge: REFRESH_TOKEN_TTL_MS
    });
}

async function issueSession(user, res, req) {
    const secret = getJwtSecret();
    const claims = { userId: user._id.toString(), username: user.username, email: user.email };
    const accessToken = jwt.sign(claims, secret, { expiresIn: ACCESS_TOKEN_TTL });
    const refreshToken = jwt.sign({ userId: claims.userId, email: user.email }, secret, { expiresIn: "7d" });

    await Session.create({
        user: user._id,
        refreshToken,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        userAgent: req.get("user-agent") || null,
        ipAddress: req.ip || null
    });
    setRefreshCookie(res, refreshToken);
    return accessToken;
}

function handleAuthError(res, error, message) {
    if (error?.code === 11000) {
        return res.status(409).json({ message: "That username or email is already registered." });
    }
    if (error.status === 503 || error.status === 429) {
        return res.status(error.status).json({ message: error.message });
    }
    console.error(message, error);
    return res.status(500).json({ message });
}

router.post("/register", async (req, res) => {
    let createdUser;
    try {
        await ensureAuthDatabase();
        getJwtSecret();
        const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
        const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
        const password = typeof req.body?.password === "string" ? req.body.password : "";
        if (!/^[a-zA-Z0-9_-]{3,24}$/.test(username)) {
            return res.status(400).json({ message: "Username must be 3-24 characters using letters, numbers, _ or -." });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ message: "Enter a valid email address." });
        }
        if (password.length < 8 || password.length > 128) {
            return res.status(400).json({ message: "Password must be between 8 and 128 characters." });
        }

        createdUser = await User.create({ username, email, password: await hashPassword(password) });
        try {
            await issueOtp(email);
        } catch (error) {
            await Otp.deleteMany({ email });
            await User.deleteOne({ _id: createdUser._id });
            throw error;
        }
        return res.status(201).json({ message: "Verification code sent to your email.", requiresOtp: true, email });
    } catch (error) {
        return handleAuthError(res, error, "Unable to create your account.");
    }
});

router.post("/login", async (req, res) => {
    try {
        await ensureAuthDatabase();
        const identifier = typeof req.body?.identifier === "string" ? req.body.identifier.trim() : "";
        const password = typeof req.body?.password === "string" ? req.body.password : "";
        if (!identifier || !password) {
            return res.status(400).json({ message: "Email/username and password are required." });
        }

        const user = await User.findOne({
            $or: [
                { email: identifier.toLowerCase() },
                { username: identifier }
            ]
        }).select("+password");
        if (!user || !(await verifyPassword(password, user.password))) {
            return res.status(401).json({ message: "Invalid email/username or password." });
        }
        getJwtSecret();
        if (!user.password.startsWith("scrypt:")) {
            user.password = await hashPassword(password);
            await user.save();
        }
        if (!user.isVerified) {
            await issueOtp(user.email);
            return res.status(200).json({ message: "Verify your email to continue. A code was sent.", requiresOtp: true, email: user.email });
        }

        await issueOtp(user.email);
        return res.status(200).json({ message: "A verification code was sent to your email.", requiresOtp: true, email: user.email });
    } catch (error) {
        return handleAuthError(res, error, "Unable to sign in.");
    }
});

router.post("/send-otp", async (req, res) => {
    try {
        await ensureAuthDatabase();
        getJwtSecret();
        const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
        if (!email) return res.status(400).json({ message: "Email is required." });
        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ message: "No account was found for this email." });
        await issueOtp(email);
        return res.status(200).json({ message: "A new verification code was sent." });
    } catch (error) {
        return handleAuthError(res, error, "Unable to send a verification code.");
    }
});

router.post("/verify-otp", async (req, res) => {
    try {
        await ensureAuthDatabase();
        getJwtSecret();
        const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
        const submittedOtp = typeof req.body?.otp === "string" ? req.body.otp.trim() : "";
        if (!email || !/^\d{6}$/.test(submittedOtp)) {
            return res.status(400).json({ message: "Enter the 6-digit code sent to your email." });
        }

        const otpRecord = await Otp.findOne({ email }).sort({ createdAt: -1 });
        if (!otpRecord || otpRecord.attempts >= 5 || Date.now() - otpRecord.createdAt.getTime() > 5 * 60 * 1000) {
            if (otpRecord) await Otp.deleteOne({ _id: otpRecord._id });
            return res.status(400).json({ message: "The code is invalid or expired. Request a new one." });
        }
        if (!isOtpMatch(otpRecord.otp, submittedOtp)) {
            otpRecord.attempts += 1;
            await otpRecord.save();
            return res.status(400).json({ message: "The code is incorrect. Check it and try again." });
        }

        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ message: "Account not found." });
        user.isVerified = true;
        await user.save();
        await Otp.deleteMany({ email });
        const accessToken = await issueSession(user, res, req);
        return res.status(200).json({ message: "Email verified.", accessToken, user: getSafeUser(user) });
    } catch (error) {
        return handleAuthError(res, error, "Unable to verify your email.");
    }
});

router.get("/get-me", requireAccessToken, async (req, res) => {
    try {
        await ensureAuthDatabase();
        const user = await User.findById(req.authUser.userId);
        if (!user || !user.isVerified) return res.status(401).json({ message: "Account is not available." });
        return res.status(200).json({ user: getSafeUser(user) });
    } catch (error) {
        return handleAuthError(res, error, "Unable to load your account.");
    }
});

router.get("/refresh-token", async (req, res) => {
    try {
        await ensureAuthDatabase();
        const refreshToken = req.cookies?.refreshToken;
        if (!refreshToken) return res.status(401).json({ message: "Sign in to continue." });
        const claims = jwt.verify(refreshToken, getJwtSecret());
        const session = await Session.findOne({
            refreshToken,
            user: claims.userId,
            isValid: true,
            expiresAt: { $gt: new Date() }
        });
        if (!session) return res.status(401).json({ message: "Your session has expired. Sign in again." });
        const user = await User.findById(claims.userId);
        if (!user || !user.isVerified) return res.status(401).json({ message: "Account is not available." });
        const accessToken = jwt.sign(
            { userId: user._id.toString(), username: user.username, email: user.email },
            getJwtSecret(),
            { expiresIn: ACCESS_TOKEN_TTL }
        );
        return res.status(200).json({ accessToken, user: getSafeUser(user) });
    } catch (error) {
        if (error.status === 503) return handleAuthError(res, error, "Unable to refresh your session.");
        return res.status(401).json({ message: "Your session has expired. Sign in again." });
    }
});

router.post("/logout", async (req, res) => {
    const refreshToken = req.cookies?.refreshToken;
    res.clearCookie("refreshToken", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/api/auth"
    });
    try {
        await ensureAuthDatabase();
        if (refreshToken) await Session.deleteOne({ refreshToken });
        return res.status(200).json({ message: "Signed out." });
    } catch (error) {
        return handleAuthError(res, error, "Unable to sign out.");
    }
});

export default router;
