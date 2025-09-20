import React, { useMemo, useState } from 'react';
import logoUrl from './logo.png';

const number = (v: number, digits = 2) => Number.isFinite(v) ? v.toFixed(digits) : '—';

function frictionFactor({ Re, eps, D }: { Re: number; eps: number; D: number }) {
  if (Re <= 0 || D <= 0) return 0;
  if (Re < 2000) return 64 / Re;
  const term = eps / (3.7 * D) + 5.74 / Math.pow(Re, 0.9);
  const f = 0.25 / Math.pow(Math.log10(term), 2);
  return f;
}

function useUFHCalculator() {
  const [Tsurf, setTsurf] = useState(29);
  const [Tair, setTair] = useState(22);
  const [stepMm, setStepMm] = useState(150);
  const [dT, setDT] = useState(5);
  const [hTotal, setHTotal] = useState(10);
  const [dpMaxKPa, setDpMaxKPa] = useState(20);
  const [feedLen, setFeedLen] = useState(10);

  type FluidKey = 'water' | 'pg30';
  const [fluid, setFluid] = useState<FluidKey>('water');
  const [Tmean, setTmean] = useState(35);

  const fluidProps = useMemo(() => {
    if (fluid === 'pg30') {
      return { rho: 1030, cp: 3800, mu: 0.0023 };
    }
    const rho = 1000 - 0.3 * (Tmean - 4);
    const mu = 0.00179 - 1.3e-5 * (Tmean - 0) - 1.7e-7 * (Tmean * Tmean);
    const cp = 4180;
    return { rho, mu: Math.max(mu, 0.00035), cp };
  }, [fluid, Tmean]);

  const defaultDiameters = [10, 12, 13, 16];
  const [selected, setSelected] = useState<number[]>(defaultDiameters);
  const [epsMm, setEpsMm] = useState(0.007);

  type HeatMode = 'byDeltaT' | 'byQ';
  const [heatMode, setHeatMode] = useState<HeatMode>('byDeltaT');
  const [qUser, setQUser] = useState(60); // Вт/м², если режим по q

  const s = stepMm / 1000;
  const qReq = useMemo(() => heatMode === 'byQ' ? Math.max(qUser, 0) : hTotal * Math.max(Tsurf - Tair, 0), [heatMode, qUser, hTotal, Tsurf, Tair]);
  const pPerM = qReq * s;
  const dpTarget = dpMaxKPa * 1000;
  const eps = epsMm / 1000;

  // Изоляция подводящих: предустановки и настраиваемые параметры
  type InsulationKey = 'pe6' | 'pe9' | 'pe13' | 'custom';
  const [insulation, setInsulation] = useState<InsulationKey>('pe9');
  const [insLambda, setInsLambda] = useState(0.035); // Вт/(м·К)
  const [insThkMm, setInsThkMm] = useState(9); // мм

  const activeInsulation = useMemo(() => {
    if (insulation === 'custom') {
      return { lambda: Math.max(insLambda, 0.005), thkM: Math.max(insThkMm, 0.1) / 1000 };
    }
    const presets: Record<Exclude<InsulationKey, 'custom'>, { lambda: number; thkM: number }> = {
      pe6: { lambda: 0.035, thkM: 0.006 },
      pe9: { lambda: 0.035, thkM: 0.009 },
      pe13: { lambda: 0.035, thkM: 0.013 },
    };
    return presets[insulation];
  }, [insulation, insLambda, insThkMm]);

  function solveMaxLengthForD(Dmm: number) {
    const D = Dmm / 1000;
    const { rho, cp, mu } = fluidProps;

    // Теплопотери на подводящих (зависят от D через r_i)
    const lambdaPipe = 0.40; // Вт/(м·К) для PE/PEX/PE-RT
    const hOutside = 8; // Вт/(м²·К)
    const wallThkM = 0.002; // 2 мм стенка
    const r_i = Math.max(D / 2, 0.0015);
    const r1 = r_i + wallThkM;
    const r2 = r1 + activeInsulation.thkM;
    const deltaT = Math.max(Tmean - Tair, 0);
    let qFeedPerM = 0;
    if (r2 > r_i) {
      const Rwall = Math.log(r1 / r_i) / (2 * Math.PI * lambdaPipe);
      const Rins = Math.log(r2 / r1) / (2 * Math.PI * activeInsulation.lambda);
      const Rout = 1 / (hOutside * 2 * Math.PI * r2);
      const Rtotal = Rwall + Rins + Rout;
      qFeedPerM = Rtotal > 0 ? deltaT / Rtotal : 0; // Вт/м
    }
    const Pfeed = qFeedPerM * feedLen; // Вт

    const dpForL = (Lloop: number) => {
      const Ptotal = pPerM * Lloop + Pfeed;
      const Q = Ptotal <= 0 ? 0 : Ptotal / (rho * cp * dT);
      if (Q <= 0) return 0;
      const A = Math.PI * (D * D) / 4;
      const v = Q / A;
      const Re = (rho * v * D) / mu;
      const f = frictionFactor({ Re, eps, D });
      const dpPerM = f * (rho * v * v / 2) * (1 / D);
      const Ltotal = Lloop + feedLen;
      const dp = dpPerM * Ltotal;
      return dp;
    };

    if (pPerM <= 0) {
      const Lloop = 0;
      const Q = 0;
      return { Dmm, Lloop, Ltotal: Lloop + feedLen, Qlm: 0, P: 0, Pfeed, Ptotal: Pfeed, qFeedPerM, area: 0, v: 0, Re: 0, dp: 0, limited: 'heat' as const };
    }

    let Llo = 0;
    let Lhi = 1;
    const maxSearch = 1e6; // технический верхний предел поиска, монтажный лимит не учитывается
    while (dpForL(Lhi) < dpTarget && Lhi < maxSearch) {
      Lhi *= 2;
    }

    for (let i = 0; i < 60; i++) {
      const Lmid = 0.5 * (Llo + Lhi);
      const dp = dpForL(Lmid);
      if (Math.abs(dp - dpTarget) < 1) { Llo = Lhi = Lmid; break; }
      if (dp > dpTarget) { Lhi = Lmid; } else { Llo = Lmid; }
    }

    let Lloop = Math.min(Lhi, maxSearch);
    const limited: 'hydraulic' = 'hydraulic';
    const P = pPerM * Lloop; // мощность пола
    const Ptotal = P + Pfeed; // суммарная мощность с потерями на подводящих
    const Q = Ptotal / (fluidProps.rho * fluidProps.cp * dT);
    const A = Math.PI * (D * D) / 4;
    const v = A > 0 ? Q / A : 0;
    const Re = (fluidProps.rho * v * D) / fluidProps.mu;
    const dpKPa = dpForL(Lloop) / 1000;
    const Ltotal = Lloop + feedLen;

    return { Dmm, Lloop, Ltotal, Qlm: Q * 60 * 1000, P, Pfeed, Ptotal, qFeedPerM, area: Lloop * s, v, Re, dp: dpKPa, limited } as const;
  }

  const results = useMemo(() => {
    return selected.map(Dmm => solveMaxLengthForD(Dmm)).sort((a, b) => a.Dmm - b.Dmm);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Tsurf, Tair, stepMm, dT, hTotal, dpMaxKPa, feedLen, fluidProps.rho, fluidProps.cp, fluidProps.mu, selected, epsMm, insulation, insLambda, insThkMm, Tmean, heatMode, qUser]);

  return {
    inputs: { Tsurf, setTsurf, Tair, setTair, stepMm, setStepMm, dT, setDT, hTotal, setHTotal, dpMaxKPa, setDpMaxKPa, feedLen, setFeedLen, fluid, setFluid, Tmean, setTmean, epsMm, setEpsMm, selected, setSelected, insulation, setInsulation, insLambda, setInsLambda, insThkMm, setInsThkMm, heatMode, setHeatMode, qUser, setQUser },
    shared: { s, qReq, pPerM },
    results,
  } as const;
}

export default function UFHLengthCalculator() {
  const { inputs, shared, results } = useUFHCalculator();
  const { s, qReq, pPerM } = shared;
  const toggleDiameter = (d: number) => {
    inputs.setSelected(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);
  };

  return (
    <div className="min-h-screen w-full bg-neutral-50 text-neutral-900 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <header className="mb-6">
          <div className="flex items-center justify-between">
            <img src={logoUrl} alt="logo" className="h-8 md:h-10 w-auto object-contain" />
            <a
              href="https://t.me/galfdesign"
              target="_blank"
              rel="noopener noreferrer"
              className="text-neutral-600 hover:text-neutral-900 transition-colors p-2 rounded-full hover:bg-neutral-100"
              aria-label="Galf Design Telegram"
              title="Galf Design Telegram"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                <path d="M9.036 15.804l-.376 5.296c.537 0 .769-.231 1.048-.508l2.516-2.416 5.213 3.829c.955.527 1.633.25 1.895-.883l3.434-16.115h.001c.306-1.43-.517-1.986-1.452-1.64L1.12 9.27c-1.408.548-1.386 1.334-.24 1.69l5.27 1.644L19.79 6.19c.595-.39 1.136-.174.69.216"></path>
              </svg>
            </a>
          </div>
          <h1 className="mt-3 text-2xl md:text-3xl font-bold text-center">Тёплый пол · длина контура</h1>
        </header>

        <div className="grid md:grid-cols-2 gap-6">
          <section className="bg-white rounded-2xl shadow p-4 md:p-6">
            <h2 className="text-lg font-semibold mb-4">Исходные данные</h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 flex items-center gap-3">
                <span className="text-sm text-neutral-600">Режим</span>
                <label htmlFor="modeToggle" className="flex items-center gap-3 cursor-pointer select-none">
                  <span className={`text-sm ${inputs.heatMode==='byDeltaT' ? 'text-neutral-900 font-medium' : 'text-neutral-500'}`}>ΔT</span>
                  <div className="relative">
                    <input id="modeToggle" type="checkbox" className="peer sr-only" checked={inputs.heatMode==='byQ'} onChange={e=>inputs.setHeatMode(e.target.checked ? 'byQ' : 'byDeltaT')} />
                    <div className="h-6 w-11 rounded-full bg-neutral-300 peer-checked:bg-neutral-900 transition-colors"></div>
                    <div className="pointer-events-none absolute top-1 left-1 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-5"></div>
                  </div>
                  <span className={`text-sm ${inputs.heatMode==='byQ' ? 'text-neutral-900 font-medium' : 'text-neutral-500'}`}>Вт/м²</span>
                </label>
              </div>

              {inputs.heatMode === 'byDeltaT' && (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-sm text-neutral-600">T поверхности пола, °C</span>
                    <input type="number" inputMode="decimal" step="any" value={inputs.Tsurf} onChange={e=>inputs.setTsurf(parseFloat(e.target.value))} className="input" />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-sm text-neutral-600">T воздуха в помещении, °C</span>
                    <input type="number" inputMode="decimal" step="any" value={inputs.Tair} onChange={e=>inputs.setTair(parseFloat(e.target.value))} className="input" />
                  </label>
                </>
              )}
              <label className="flex flex-col gap-1">
                <span className="text-sm text-neutral-600">Шаг укладки, мм</span>
                <select
                  className="input"
                  value={inputs.stepMm}
                  onChange={e => inputs.setStepMm(parseInt(e.target.value, 10))}
                >
                  {[100,150,200,250,300].map(v => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-neutral-600">ΔT теплоносителя, K</span>
                <input type="number" inputMode="decimal" step="any" value={inputs.dT} onChange={e=>inputs.setDT(parseFloat(e.target.value))} className="input" />
              </label>
              {inputs.heatMode === 'byDeltaT' ? (
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-neutral-600">Коэфф. теплоотдачи пола h, Вт/м²·K</span>
                  <input type="number" inputMode="decimal" step="any" value={inputs.hTotal} onChange={e=>inputs.setHTotal(parseFloat(e.target.value))} className="input" />
                  <span className="text-xs text-neutral-500">Обычный диапазон 8–11 Вт/м²·K (зависит от конвекции/излучения).</span>
                </label>
              ) : (
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-neutral-600">Удельная мощность пола q, Вт/м²</span>
                  <input type="number" inputMode="decimal" step="any" value={inputs.qUser} onChange={e=>inputs.setQUser(parseFloat(e.target.value))} className="input" />
                  <span className="text-xs text-neutral-500">Типичные значения 40–80 Вт/м² (зависит от покрытия и ΔT).</span>
                </label>
              )}
              <label className="flex flex-col gap-1">
                <span className="text-sm text-neutral-600">Допустимый Δp на контур, кПа</span>
                <input type="number" inputMode="decimal" step="any" value={inputs.dpMaxKPa} onChange={e=>inputs.setDpMaxKPa(parseFloat(e.target.value))} className="input" />
              </label>
              
            </div>
            <div className="mt-6 border-t pt-4">
              <h3 className="text-md font-semibold mb-2">Жидкость и свойства</h3>
              <div className="grid grid-cols-2 gap-4">
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-neutral-600">Тип жидкости</span>
                  <select value={inputs.fluid} onChange={e=>inputs.setFluid(e.target.value as any)} className="input">
                    <option value="water">Вода</option>
                    <option value="pg30">Пропиленгликоль 30%</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-neutral-600">Средняя T теплоносителя, °C</span>
                  <input type="number" inputMode="decimal" step="any" value={inputs.Tmean} onChange={e=>inputs.setTmean(parseFloat(e.target.value))} className="input" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-neutral-600">Шероховатость ε, мм</span>
                  <input type="number" inputMode="decimal" step="any" value={inputs.epsMm} onChange={e=>inputs.setEpsMm(parseFloat(e.target.value))} className="input" />
                </label>
                <div className="text-xs text-neutral-500 self-end">
                  Для воды cp≈4180 Дж/(кг·K). Для 30% PG cp≈3800 Дж/(кг·K), ρ≈1030 кг/м³, μ≈2.3 мПа·с.
                </div>
              </div>
            </div>

            <div className="mt-6 border-t pt-4">
              <h3 className="text-md font-semibold mb-2">Подводящие и изоляция</h3>
              <div className="grid grid-cols-2 gap-4">
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-neutral-600">Тип изоляции</span>
                  <select className="input" value={inputs.insulation} onChange={e=>inputs.setInsulation(e.target.value as any)}>
                    <option value="pe6">ПеноПЭ 6 мм (λ=0.035)</option>
                    <option value="pe9">ПеноПЭ 9 мм (λ=0.035)</option>
                    <option value="pe13">ПеноПЭ 13 мм (λ=0.035)</option>
                    <option value="custom">Своя</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-neutral-600">Длина подводящих, м</span>
                  <input type="number" inputMode="decimal" step="any" value={inputs.feedLen} onChange={e=>inputs.setFeedLen(parseFloat(e.target.value))} className="input" />
                </label>

                {inputs.insulation === 'custom' && (
                  <>
                    <label className="flex flex-col gap-1">
                      <span className="text-sm text-neutral-600">λ изоляции, Вт/(м·K)</span>
                      <input type="number" inputMode="decimal" step="any" value={inputs.insLambda} onChange={e=>inputs.setInsLambda(parseFloat(e.target.value))} className="input" />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-sm text-neutral-600">Толщина изоляции, мм</span>
                      <input type="number" inputMode="numeric" step="1" value={inputs.insThkMm} onChange={e=>inputs.setInsThkMm(parseFloat(e.target.value))} className="input" />
                    </label>
                  </>
                )}
                <div className="text-xs text-neutral-500 col-span-2">
                  Потери на подводящих учитываются в требуемой тепловой мощности контура и увеличивают расчётный расход. Модель: q' = 2πλΔT / ln(r2/r1).
                </div>
              </div>
            </div>
          </section>

          <section className="bg-white rounded-2xl shadow p-4 md:p-6">
            <h2 className="text-lg font-semibold mb-4">Сводка по теплу и расходу</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="stat">
                <div className="stat-title">Тепловой поток пола q</div>
                <div className="stat-value">{number(qReq, 1)} <span className="text-base">Вт/м²</span></div>
                <div className="stat-desc">q = h·(Tпов−Tвоз)</div>
              </div>
              <div className="stat">
                <div className="stat-title">Мощность на метр трубы</div>
                <div className="stat-value">{number(pPerM, 1)} <span className="text-base">Вт/м</span></div>
                <div className="stat-desc">p<sub>м</sub> = q·шаг</div>
              </div>
              <div className="stat">
                <div className="stat-title">Шаг, м</div>
                <div className="stat-value">{number(s, 3)}</div>
                <div className="stat-desc">{inputs.stepMm} мм</div>
              </div>
            </div>
            <div className="mt-6">
              <h3 className="text-md font-semibold mb-2">Выберите внутренние диаметры (мм)</h3>
              <div className="flex flex-wrap gap-2">
                {[10, 12, 13, 14, 16, 18].map(d => (
                  <button key={d} onClick={() => toggleDiameter(d)} className={`px-3 py-1 rounded-full text-sm border ${inputs.selected.includes(d) ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white text-neutral-800 border-neutral-300'}`}>
                    {d}
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>

        <section className="bg-white rounded-2xl shadow p-4 md:p-6 mt-6">
          <h2 className="text-lg font-semibold mb-4">Результаты по диаметрам</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="stat">
              <div className="stat-title">Потери на подводящих q'</div>
              <div className="stat-value">{number((results[0]?.qFeedPerM) ?? 0, 2)} <span className="text-base">Вт/м</span></div>
              <div className="stat-desc">Оценка на текущем диаметре</div>
            </div>
            <div className="stat">
              <div className="stat-title">P подводящих</div>
              <div className="stat-value">{number((results[0]?.Pfeed) ?? 0, 0)} <span className="text-base">Вт</span></div>
              <div className="stat-desc">q' · Lподв</div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-4">D<sub>вн</sub>, мм</th>
                  <th className="py-2 pr-4">L<sub>контур</sub>, м</th>
                  <th className="py-2 pr-4">L<sub>общ</sub>, м</th>
                  <th className="py-2 pr-4">Расход, л/мин</th>
                  <th className="py-2 pr-4">P контура, Вт</th>
                  <th className="py-2 pr-4">Площадь, м²</th>
                  <th className="py-2 pr-4">Pподв, Вт</th>
                  <th className="py-2 pr-4">Pсумм, Вт</th>
                  <th className="py-2 pr-4">v, м/с</th>
                  <th className="py-2 pr-4">Re</th>
                  <th className="py-2 pr-4">Δp, кПа</th>
                  <th className="py-2 pr-4">Ограничение</th>
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.Dmm} className="border-b hover:bg-neutral-50">
                    <td className="py-2 pr-4 font-medium">{r.Dmm}</td>
                    <td className="py-2 pr-4">{number(r.Lloop, 1)}</td>
                    <td className="py-2 pr-4">{number(r.Ltotal, 1)}</td>
                    <td className="py-2 pr-4">{number(r.Qlm, 2)}</td>
                    <td className="py-2 pr-4">{number(r.P, 0)}</td>
                    <td className="py-2 pr-4">{number(r.area, 2)}</td>
                    <td className="py-2 pr-4">{number(r.Pfeed ?? 0, 0)}</td>
                    <td className="py-2 pr-4">{number(r.Ptotal ?? r.P, 0)}</td>
                    <td className="py-2 pr-4">{number(r.v, 3)}</td>
                    <td className="py-2 pr-4">{number(r.Re, 0)}</td>
                    <td className="py-2 pr-4">{number(r.dp, 2)}</td>
                    <td className="py-2 pr-4">{r.limited === 'hydraulic' ? 'гидравлика' : 'тепло'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 text-xs text-neutral-600 leading-relaxed">
            <p className="mb-2">Примечания и допущения:</p>
            <ul className="list-disc ml-5 space-y-1">
              <li>Два режима теплопередачи: по ΔT (<em>q = h·(Tпов−Tвоз)</em>) и по заданной удельной мощности <em>q</em> (Вт/м²).</li>
              <li>Мощность «на метр» трубы: <em>p<sub>м</sub> = q·шаг</em>; обслуживаемая площадь при укладке «улиткой»: <em>A ≈ L·шаг</em>.</li>
              <li>Потери на подводящих учитываются: модель цилиндрической изоляции с сопротивлениями стенки, изоляции и наружной конвекции: <em>q' = ΔT / (Rстенка + Rизоляция + Rнаружн)</em>. Эти потери добавляются к требуемой мощности и увеличивают расчётный расход. В гидравлике подводящие учитываются как добавочная длина.</li>
              <li>Гидравлика: формула Дарси–Вейсбаха; коэффициент трения — <em>64/Re</em> (ламинарный) и Swamee–Jain (турбулентный). Шероховатость по умолчанию для PEX/PE‑RT: ε≈0.007 мм.</li>
              <li>Монтажного ограничения по длине нет; ограничение — только по гидравлике (допустимый Δp).</li>
              <li>Свойства теплоносителя берутся при средней температуре; для гликоля повышенная вязкость увеличивает сопротивление и требуемый расход.</li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}


