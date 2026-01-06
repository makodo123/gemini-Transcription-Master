import React from 'react';
import { CreditCard, AlertTriangle } from 'lucide-react';

interface QuotaDisplayProps {
  quotaPercentage: number; // 0 to 100
  apiKey: string;
}

const QuotaDisplay: React.FC<QuotaDisplayProps> = ({ quotaPercentage, apiKey }) => {
  // Safe extraction of last 4 digits
  const lastFour = apiKey && apiKey.length > 4 ? apiKey.slice(-4) : '****';
  
  // Determine color based on usage
  let colorClass = "bg-green-500";
  if (quotaPercentage < 30) colorClass = "bg-orange-500";
  if (quotaPercentage < 10) colorClass = "bg-red-600";

  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-4 flex flex-col gap-3">
      <div className="flex justify-between items-center text-sm text-slate-600">
        <span className="flex items-center gap-2">
          <CreditCard className="w-4 h-4" />
          API Key: <span className="font-mono bg-slate-100 px-1 rounded text-slate-800">...{lastFour}</span>
        </span>
        <span className="font-medium">{quotaPercentage}% 額度</span>
      </div>

      <div className="h-2.5 w-full bg-slate-100 rounded-full overflow-hidden">
        <div 
          className={`h-full ${colorClass} transition-all duration-500`} 
          style={{ width: `${quotaPercentage}%` }}
        />
      </div>

      {quotaPercentage < 20 && (
        <div className="flex items-start gap-2 text-xs text-red-600 bg-red-50 p-2 rounded animate-pulse">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>API 額度即將不足，請留意您的使用量或切換 Key。</span>
        </div>
      )}
    </div>
  );
};

export default QuotaDisplay;
