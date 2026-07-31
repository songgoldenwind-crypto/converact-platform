interface StatsCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: 'up' | 'down' | 'neutral';
}

const trendIcons: Record<string, string> = {
  up: '↑',
  down: '↓',
  neutral: '→',
};

const trendColors: Record<string, string> = {
  up: 'text-green-500',
  down: 'text-red-500',
  neutral: 'text-gray-400',
};

export default function StatsCard({ title, value, subtitle, trend }: StatsCardProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-100 p-5">
      <p className="text-sm text-gray-500 font-medium">{title}</p>
      <div className="flex items-end gap-2 mt-1">
        <p className="text-2xl font-semibold text-gray-900">{value}</p>
        {trend && (
          <span className={`text-sm font-medium ${trendColors[trend]}`}>
            {trendIcons[trend]}
          </span>
        )}
      </div>
      {subtitle && (
        <p className="text-xs text-gray-400 mt-1">{subtitle}</p>
      )}
    </div>
  );
}
