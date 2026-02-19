/** Shared types and interface for Twitter read operations. */

export interface Tweet {
  id: string
  url: string
  text: string
  likeCount: number
  retweetCount: number
  replyCount: number
  quoteCount: number
  viewCount: number
  createdAt: string
  lang: string
  isReply: boolean
  inReplyToId: string
  author: User
  extendedEntities?: {
    media?: Array<{ type: string; media_url_https: string }>
  }
  media?: {
    photos?: Array<{ url: string }>
    videos?: Array<{ poster: string }>
  }
}

export interface User {
  id: string
  userName: string
  name: string
  isBlueVerified: boolean
  followers: number
  following: number
  profilePicture: string
  description: string
  location?: string
  createdAt?: string
  statusesCount?: number
}

export interface SearchResult {
  tweets: Tweet[]
  has_next_page: boolean
  next_cursor: string
}

export interface MentionsResult {
  tweets: Tweet[]
  has_next_page: boolean
  next_cursor: string
}

export interface FollowersResult {
  followers: User[]
  has_next_page: boolean
  next_cursor: string
}

export interface UserTweetsResult {
  tweets: Tweet[]
  has_next_page: boolean
  next_cursor: string
}

export interface TwitterReadProvider {
  readonly name: string
  search(query: string, queryType?: 'Latest' | 'Top', cursor?: string): Promise<SearchResult>
  getMentions(userName: string, sinceTime?: number, cursor?: string): Promise<MentionsResult>
  getUserInfo(userName: string): Promise<User | null>
  getFollowers(userName: string, cursor?: string): Promise<FollowersResult>
  getUserTweets(userName: string, cursor?: string): Promise<UserTweetsResult>
  findTopTweet(query: string, minLikes?: number): Promise<string | undefined>
  getTweetById(tweetId: string): Promise<Tweet | null>
}
