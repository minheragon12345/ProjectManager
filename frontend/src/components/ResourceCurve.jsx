import { useEffect, useMemo, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { getResourceCurve } from '../services/projectService';
import { useI18n } from '../i18n';
import './ResourceCurve.css';

const UNIT_LABEL = { hour: 'h', day: 'd', week: 'w', month: 'mo' };

/**
 * Renders a resource-loading curve (cumulative peopleRequired over time)
 * with a horizontal reference line at the project's headcount cap.
 *
 * Props:
 *   projectId — string
 *   constrained — use the headcount-limited schedule
 *   refreshKey — optional value; when it changes, refetch (e.g. on task save)
 */
export default function ResourceCurve({ projectId, constrained = false, refreshKey }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getResourceCurve(projectId, { constrained })
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || 'Failed to load resource curve');
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, constrained, refreshKey]);

  const unitShort = UNIT_LABEL[data?.timeUnit] || 'd';

  // Split each point into safe (under reference) and over (overshoot)
  // segments so we can stack two areas: gray under, red over.
  const chartData = useMemo(() => {
    if (!data || !Array.isArray(data.points)) return [];
    const ref = Number(data.reference) || 0;
    return data.points.map((p) => ({
      t: p.t,
      demand: p.demand,
      safe: Math.min(p.demand, ref),
      over: Math.max(0, p.demand - ref),
    }));
  }, [data]);

  if (!projectId) return null;
  if (loading && !data) {
    return <div className="resource-curve-empty">{t('rc.loading')}</div>;
  }
  if (error) {
    return <div className="resource-curve-empty error">{t('rc.failed', { msg: error })}</div>;
  }
  if (!data || chartData.length === 0) {
    return <div className="resource-curve-empty">{t('rc.empty')}</div>;
  }

  const peak = Number(data.peak) || 0;
  const reference = Number(data.reference) || 0;
  const overPeak = peak > reference;

  return (
    <div className="resource-curve-wrapper">
      <div className="resource-curve-header">
        <div className="rc-stat">
          <span className="rc-label">{t('rc.peak')}</span>
          <span className={`rc-value ${overPeak ? 'rc-over' : ''}`}>
            {peak} {t('rc.peopleAxis')}
          </span>
        </div>
        <div className="rc-stat">
          <span className="rc-label">{t('rc.cap')}</span>
          <span className="rc-value">{reference}</span>
        </div>
        <div className="rc-stat">
          <span className="rc-label">{t('rc.span')}</span>
          <span className="rc-value">
            {data.projectDuration}
            {unitShort}
          </span>
        </div>
        {overPeak ? (
          <div className="rc-alert">
            {t('rc.exceeds', { n: peak - reference })}
          </div>
        ) : null}
      </div>

      <div className="resource-curve-chart">
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart
            data={chartData}
            margin={{ top: 8, right: 20, left: 0, bottom: 16 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-primary, #e5e7eb)" />
            <XAxis
              dataKey="t"
              type="number"
              domain={[0, 'dataMax']}
              stroke="var(--text-secondary, #4b5563)"
              tick={{ fontSize: 12 }}
              label={{
                value: t('rc.timeAxis', { unit: unitShort }),
                position: 'insideBottom',
                offset: -8,
                style: { fill: 'var(--text-tertiary, #9ca3af)', fontSize: 11 },
              }}
            />
            <YAxis
              stroke="var(--text-secondary, #4b5563)"
              tick={{ fontSize: 12 }}
              allowDecimals={false}
              label={{
                value: t('rc.peopleAxis'),
                angle: -90,
                position: 'insideLeft',
                style: { fill: 'var(--text-tertiary, #9ca3af)', fontSize: 11 },
              }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--surface-primary, #fff)',
                border: '1px solid var(--border-primary, #e5e7eb)',
                fontSize: 12,
              }}
              formatter={(value, name) => {
                if (name === 'safe') return [value, t('rc.withinCap')];
                if (name === 'over') return [value, t('rc.overCap')];
                return [value, name];
              }}
              labelFormatter={(tt) => `t = ${tt}${unitShort}`}
            />
            <ReferenceLine
              y={reference}
              stroke="#6366f1"
              strokeDasharray="4 4"
              label={{
                value: `cap ${reference}`,
                position: 'right',
                fill: '#6366f1',
                fontSize: 11,
              }}
            />
            <Area
              type="stepAfter"
              dataKey="safe"
              stackId="1"
              stroke="#4b5563"
              fill="#9ca3af"
              fillOpacity={0.4}
              isAnimationActive={false}
            />
            <Area
              type="stepAfter"
              dataKey="over"
              stackId="1"
              stroke="#b91c1c"
              fill="#fca5a5"
              fillOpacity={0.7}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
