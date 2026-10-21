import { ArrowRight, BadgePercent, Laptop, ReceiptText, ShieldCheck, Zap } from "lucide-react";
import { Logo, ThemeToggle } from "../components/TopBar";
import { useEffect, useState } from "react";
import { auth } from "../lib/api";
import { navigate } from "../lib/nav";

const features = [
  { icon: BadgePercent, title: "Your contract pricing", body: "Every price you see is the rate your account negotiated, including quantity breaks." },
  { icon: Zap, title: "Order by SKU in seconds", body: "Type a code, a quantity, press Enter. Paste a whole list from your estimate." },
  { icon: ReceiptText, title: "Statements and credit", body: "Live balance, aged debt and what is due next, without waiting for a statement run." },
  { icon: Laptop, title: "Desktop app for the counter", body: "An offline catalogue with instant lookups, issued to approved accounts only." },
];

const steps = [
  { title: "Apply", body: "Tell us about your business. It takes two minutes." },
  { title: "Get approved", body: "We set your credit terms and account pricing." },
  { title: "Order", body: "Sign in and order at your prices, on the web or the desktop app." },
];

export function Landing({ theme, onToggleTheme }: { theme: "light" | "dark"; onToggleTheme: () => void }) {
  const [business, setBusiness] = useState("DROPLET");
  useEffect(() => {
    void auth.profile().then((p) => setBusiness(p.name)).catch(() => undefined);
  }, []);
  return (
    <div className="mx-auto flex min-h-screen max-w-[1200px] flex-col px-4 py-4 sm:px-6">
      <header className="glass flex items-center gap-3 rounded-full px-4 py-2.5">
        <Logo />
        <nav className="ml-auto flex items-center gap-2">
          <ThemeToggle theme={theme} onToggleTheme={onToggleTheme} />
          <button className="btn-ghost rounded-full py-2" onClick={() => navigate("/apply")}>
            Apply for an account
          </button>
          <button className="btn-primary rounded-full py-2" onClick={() => navigate("/login")}>
            Sign in
          </button>
        </nav>
      </header>

      <main className="flex flex-1 flex-col justify-center py-12">
        <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <span className="chip">
              <ShieldCheck className="h-3.5 w-3.5 text-accent" /> Approved trade accounts only
            </span>
            <h1 className="mt-5 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
              Trade ordering at
              <br />
              <span className="text-accent">your contract price.</span>
            </h1>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted">
              The {business} trade portal: your negotiated pricing, fast SKU entry, quotes, reorders and statements
              in one place.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <button className="btn-primary px-5 py-3" onClick={() => navigate("/login")}>
                Sign in to your portal <ArrowRight className="h-4 w-4" />
              </button>
              <button className="btn-ghost px-5 py-3" onClick={() => navigate("/apply")}>
                Open a trade account
              </button>
            </div>
          </div>

          <div className="glass p-5 sm:p-6">
            <span className="section-title">How it works</span>
            <ol className="mt-4 space-y-3">
              {steps.map((step, i) => (
                <li key={step.title} className="glass-inset flex items-start gap-3 p-3.5">
                  <span className="num grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-onaccent">{i + 1}</span>
                  <div>
                    <div className="text-sm font-semibold">{step.title}</div>
                    <div className="text-sm text-muted">{step.body}</div>
                  </div>
                </li>
              ))}
            </ol>
            <button className="btn-primary mt-4 w-full" onClick={() => navigate("/apply")}>Start an application</button>
          </div>
        </div>

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f) => (
            <div key={f.title} className="glass p-5">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent text-onaccent">
                <f.icon className="h-5 w-5" />
              </span>
              <h2 className="mt-4 text-[15px] font-semibold">{f.title}</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </main>

      <footer className="py-6 text-center text-xs text-muted">© {new Date().getFullYear()} {business}. Trade accounts are subject to credit approval.</footer>
    </div>
  );
}
