export interface GrokMetadata {
  storyId: string
  headline: string
  summary: string
  hook?: string
  category?: string
  topics?: string[]
  entities?: {
    events?: string[]
    organizations?: string[]
    people?: string[]
    places?: string[]
    products?: string[]
  }
  keywords?: string[]
  postIds: string[]
}

export interface Signal {
  id: string
  source: 'twitter' | 'reddit' | 'hn' | 'google-news'
  type: 'trend' | 'tweet' | 'post' | 'headline'
  content: string
  url: string
  tweetId?: string
  author?: string
  mediaUrls?: string[]
  metrics?: {
    likes?: number
    retweets?: number
    comments?: number
    score?: number
    trendRank?: number
  }
  ingestedAt: number
  expiresAt: number
  grok?: GrokMetadata
}

export interface TopicScores {
  virality: number
  visualPotential: number
  audienceBreadth: number
  timeliness: number
  humor: number
  worldviewAlignment: number
  composite: number
}

export interface Topic {
  id: string
  signals: string[]
  summary: string
  scores: TopicScores
  safety: { passed: boolean; reason?: string }
  status: 'candidate' | 'shortlisted' | 'selected' | 'posted' | 'rejected'
  evaluatedAt: number
}

export interface CartoonConcept {
  id: string
  topicId: string
  visual: string
  composition: string
  caption: string
  jokeType: string
  reasoning: string
  referenceImageUrls?: string[]
}

export interface ConceptCritique {
  conceptId: string
  humor: number
  clarity: number
  shareability: number
  visualSimplicity: number
  overallScore: number
  critique: string
}

export interface Cartoon {
  id: string
  conceptId: string
  topicId: string
  type: 'flagship' | 'quickhit' | 'paid'
  concept: CartoonConcept
  imagePrompt: string
  variants: string[]
  selectedVariant: number
  critique: ConceptCritique
  caption: string
  createdAt: number
}

export interface Post {
  id: string
  tweetId: string
  cartoonId?: string
  text: string
  imageUrl?: string
  videoUrl?: string
  quotedTweetId?: string
  type: 'flagship' | 'quickhit' | 'paid' | 'engagement'
  postedAt: number
  engagement: {
    likes: number
    retweets: number
    replies: number
    views: number
    lastChecked: number
  }
}

