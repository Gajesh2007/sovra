export type AgentState =
  | 'scanning'
  | 'monologuing'
  | 'shortlisting'
  | 'ideating'
  | 'generating'
  | 'critiquing'
  | 'composing'
  | 'posting'
  | 'engaging'
  | 'auctioning'

export type ConsoleEvent =
  | { type: 'monologue'; text: string; state: AgentState; ts: number; tweetId?: string }
  | { type: 'scan'; source: string; signalCount: number; ts: number }
  | { type: 'shortlist'; topics: { id: string; summary: string; score: number }[]; ts: number }
  | { type: 'ideate'; concepts: { id: string; caption: string }[]; topicId: string; ts: number }
  | { type: 'generate'; prompt: string; variantCount: number; ts: number }
  | { type: 'critique'; critique: string; selected: number; ts: number }
  | { type: 'post'; tweetId: string; text: string; imageUrl?: string; ts: number }
  | { type: 'engage'; replyTo: string; text: string; ts: number }
  | { type: 'auction'; action: string; details: Record<string, unknown>; ts: number }
  | { type: 'voice'; url: string; text: string; ts: number }
  | { type: 'state_change'; from: AgentState; to: AgentState; ts: number }
  | { type: 'metric'; name: string; value: number; ts: number }

export interface LocalPost {
  id: string
  tweetId?: string
  text: string
  imagePath: string | null
  videoPath: string | null
  quotedTweetId?: string
  signature?: string
  signerAddress?: string
  createdAt: number
}
