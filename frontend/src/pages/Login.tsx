import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../store/auth";
import { APP_NAME, APP_TAGLINE } from "../branding";
import ThemeToggle from "../components/ui/ThemeToggle";

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, register, loading, error } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (mode === "register") {
      const ok = await register(username, password);
      if (ok) {
        setNotice("Account created — please sign in.");
        setMode("login");
      }
      return;
    }
    const ok = await login(username, password);
    if (ok) navigate("/");
  }

  return (
    <div className="relative flex min-h-full items-center justify-center px-4">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg dark:bg-slate-800">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-bold text-brand dark:text-brand-soft">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">{APP_TAGLINE}</p>
        </div>

        <div className="mb-6 flex rounded-lg bg-gray-100 p-1 text-sm font-medium dark:bg-slate-700">
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 rounded-md py-2 capitalize transition ${
                mode === m
                  ? "bg-white text-brand shadow dark:bg-slate-900 dark:text-brand-soft"
                  : "text-gray-500 dark:text-slate-400"
              }`}
            >
              {m === "login" ? "Sign in" : "Register"}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-slate-200">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
              autoComplete="username"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-slate-200">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            />
          </div>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          {notice && <p className="text-sm text-green-700 dark:text-green-400">{notice}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-brand py-2.5 font-medium text-white transition hover:bg-brand-light disabled:opacity-50"
          >
            {loading ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}
