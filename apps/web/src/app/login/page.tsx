// login — placeholder. admin access is separate from consumer auth, with
// role-based access (goal.md §25.3). nothing here pretends to authenticate.

export default function LoginPage() {
  return (
    <div className="login-box">
      <h1>console login</h1>
      <p className="subtitle">founder access only</p>

      <input type="email" placeholder="email" disabled aria-label="email (auth not wired)" />
      <button className="primary" disabled>
        sign in — not wired yet
      </button>

      <p className="note">
        BLOCKED: supabase project. admin auth is separate from consumer sign in
        with apple, role-based, and every console action lands in an immutable
        audit record (§25.3, §31). until that exists, this page is honestly inert.
      </p>
    </div>
  );
}
