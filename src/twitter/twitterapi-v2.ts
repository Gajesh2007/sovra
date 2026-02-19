import {
  TwitterApi,
  type TweetV2,
  type UserV2,
  type MediaObjectV2,
  type TweetSearchRecentV2Paginator,
  type TweetUserMentionTimelineV2Paginator,
  type TweetUserTimelineV2Paginator,
} from 'twitter-api-v2'
import type {
  Tweet, User, SearchResult, MentionsResult,
  FollowersResult, UserTweetsResult, TwitterReadProvider,
} from './provider.js'

export class TwitterV2Reader implements TwitterReadProvider {
  readonly name = 'v2'
  private bearer: TwitterApi
  private oauth: TwitterApi
  private userIdCache = new Map<string, string>()

  constructor(bearerToken: string, oauth: TwitterApi) {
    this.bearer = new TwitterApi(bearerToken)
    this.oauth = oauth
  }

  async search(query: string, queryType: 'Latest' | 'Top' = 'Latest', cursor?: string): Promise<SearchResult> {
    const result = await this.bearer.v2.search(query, {
      'tweet.fields': ['public_metrics', 'author_id', 'created_at', 'entities', 'lang',
        'referenced_tweets', 'attachments'],
      expansions: ['author_id', 'attachments.media_keys'],
      'user.fields': ['username', 'name', 'public_metrics', 'verified',
        'profile_image_url', 'description'],
      'media.fields': ['url', 'type', 'preview_image_url'],
      max_results: 50,
      sort_order: queryType === 'Latest' ? 'recency' : 'relevancy',
      ...(cursor ? { next_token: cursor } : {}),
    })

    const authors = this.indexUsers(result.includes?.users)
    const mediaMap = this.indexMedia(result.includes?.media)

    const tweets: Tweet[] = (result.data?.data ?? []).map(t => {
      const author = authors.get(t.author_id ?? '') ?? unknownAuthor()
      return this.mapTweet(t, author, mediaMap)
    })

    if (queryType === 'Top') {
      tweets.sort((a, b) => b.likeCount - a.likeCount)
    }

    return {
      tweets,
      has_next_page: !!result.meta?.next_token,
      next_cursor: result.meta?.next_token ?? '',
    }
  }

  async getMentions(userName: string, sinceTime?: number, cursor?: string): Promise<MentionsResult> {
    const userId = await this.resolveUserId(userName)
    if (!userId) return { tweets: [], has_next_page: false, next_cursor: '' }

    const result = await this.oauth.v2.userMentionTimeline(userId, {
      'tweet.fields': ['public_metrics', 'author_id', 'created_at', 'entities', 'lang',
        'referenced_tweets'],
      expansions: ['author_id'],
      'user.fields': ['username', 'name', 'public_metrics', 'verified',
        'profile_image_url', 'description'],
      max_results: 100,
      ...(sinceTime ? { start_time: new Date(sinceTime * 1000).toISOString() } : {}),
      ...(cursor ? { pagination_token: cursor } : {}),
    })

    const authors = this.indexUsers(result.includes?.users)
    const tweets = (result.data?.data ?? []).map(t => {
      const author = authors.get(t.author_id ?? '') ?? unknownAuthor()
      return this.mapTweet(t, author)
    })

    return {
      tweets,
      has_next_page: !!result.meta?.next_token,
      next_cursor: result.meta?.next_token ?? '',
    }
  }

  async getUserInfo(userName: string): Promise<User | null> {
    try {
      const result = await this.bearer.v2.userByUsername(userName, {
        'user.fields': ['public_metrics', 'verified', 'profile_image_url',
          'description', 'location', 'created_at'],
      })
      if (!result.data) return null
      this.userIdCache.set(userName.toLowerCase(), result.data.id)
      return this.mapUser(result.data)
    } catch {
      return null
    }
  }

  async getFollowers(userName: string, cursor?: string): Promise<FollowersResult> {
    const userId = await this.resolveUserId(userName)
    if (!userId) return { followers: [], has_next_page: false, next_cursor: '' }

    const result = await this.bearer.v2.followers(userId, {
      'user.fields': ['public_metrics', 'verified', 'profile_image_url',
        'description', 'location', 'created_at'],
      max_results: 100,
      asPaginator: true,
      ...(cursor ? { pagination_token: cursor } : {}),
    })

    const users: User[] = []
    for (const u of result) {
      users.push(this.mapUser(u))
    }

    return {
      followers: users,
      has_next_page: !result.done,
      next_cursor: (result.meta as { next_token?: string })?.next_token ?? '',
    }
  }

  async getUserTweets(userName: string, cursor?: string): Promise<UserTweetsResult> {
    const userId = await this.resolveUserId(userName)
    if (!userId) return { tweets: [], has_next_page: false, next_cursor: '' }

    const result = await this.oauth.v2.userTimeline(userId, {
      'tweet.fields': ['public_metrics', 'author_id', 'created_at', 'entities', 'lang',
        'referenced_tweets', 'attachments'],
      expansions: ['author_id', 'attachments.media_keys'],
      'user.fields': ['username', 'name', 'public_metrics', 'verified',
        'profile_image_url', 'description'],
      'media.fields': ['url', 'type', 'preview_image_url'],
      max_results: 20,
      ...(cursor ? { pagination_token: cursor } : {}),
    })

    const authors = this.indexUsers(result.includes?.users)
    const mediaMap = this.indexMedia(result.includes?.media)

    const tweets = (result.data?.data ?? []).map(t => {
      const author = authors.get(t.author_id ?? '') ?? unknownAuthor()
      return this.mapTweet(t, author, mediaMap)
    })

    return {
      tweets,
      has_next_page: !!result.meta?.next_token,
      next_cursor: result.meta?.next_token ?? '',
    }
  }

  async getTweetById(tweetId: string): Promise<Tweet | null> {
    try {
      const result = await this.bearer.v2.singleTweet(tweetId, {
        'tweet.fields': ['public_metrics', 'author_id', 'created_at', 'entities', 'lang',
          'referenced_tweets'],
        expansions: ['author_id'],
        'user.fields': ['username', 'name', 'public_metrics', 'verified',
          'profile_image_url', 'description'],
      })
      if (!result.data) return null
      const authors = this.indexUsers(result.includes?.users)
      const author = authors.get(result.data.author_id ?? '') ?? unknownAuthor()
      return this.mapTweet(result.data, author)
    } catch {
      return null
    }
  }

  async findTopTweet(query: string, minLikes = 500): Promise<string | undefined> {
    const result = await this.search(`${query} -is:retweet lang:en`, 'Top')
    const qualifying = result.tweets.filter(t => t.likeCount >= minLikes)
    if (qualifying.length === 0) return undefined
    qualifying.sort((a, b) => b.likeCount - a.likeCount)
    return qualifying[0].id
  }

  // --- Internals ---

  private async resolveUserId(userName: string): Promise<string | null> {
    const key = userName.toLowerCase()
    if (this.userIdCache.has(key)) return this.userIdCache.get(key)!
    try {
      const result = await this.bearer.v2.userByUsername(userName)
      if (!result.data) return null
      this.userIdCache.set(key, result.data.id)
      return result.data.id
    } catch {
      return null
    }
  }

  private indexUsers(users?: UserV2[]): Map<string, User> {
    const map = new Map<string, User>()
    if (!users) return map
    for (const u of users) {
      const mapped = this.mapUser(u)
      map.set(mapped.id, mapped)
      this.userIdCache.set(mapped.userName.toLowerCase(), mapped.id)
    }
    return map
  }

  private indexMedia(media?: MediaObjectV2[]): Map<string, { type: string; url: string }> {
    const map = new Map<string, { type: string; url: string }>()
    if (!media) return map
    for (const m of media) {
      if (m.media_key) {
        map.set(m.media_key, {
          type: m.type ?? 'photo',
          url: m.url ?? m.preview_image_url ?? '',
        })
      }
    }
    return map
  }

  private mapTweet(
    t: TweetV2,
    author: User,
    mediaMap?: Map<string, { type: string; url: string }>,
  ): Tweet {
    const pm = t.public_metrics
    const replyRef = t.referenced_tweets?.find(r => r.type === 'replied_to')

    const mediaKeys = (t.attachments as { media_keys?: string[] })?.media_keys ?? []
    const mediaEntries: Array<{ type: string; media_url_https: string }> = []
    const photoEntries: Array<{ url: string }> = []

    if (mediaMap) {
      for (const key of mediaKeys) {
        const m = mediaMap.get(key)
        if (!m) continue
        mediaEntries.push({ type: m.type, media_url_https: m.url })
        if (m.type === 'photo' && m.url) photoEntries.push({ url: m.url })
      }
    }

    return {
      id: t.id,
      url: `https://x.com/${author.userName}/status/${t.id}`,
      text: t.text,
      likeCount: pm?.like_count ?? 0,
      retweetCount: pm?.retweet_count ?? 0,
      replyCount: pm?.reply_count ?? 0,
      quoteCount: pm?.quote_count ?? 0,
      viewCount: pm?.impression_count ?? 0,
      createdAt: t.created_at ?? new Date().toISOString(),
      lang: t.lang ?? 'en',
      isReply: !!replyRef,
      inReplyToId: replyRef?.id ?? '',
      author,
      extendedEntities: mediaEntries.length > 0 ? { media: mediaEntries } : undefined,
      media: photoEntries.length > 0 ? { photos: photoEntries } : undefined,
    }
  }

  private mapUser(u: UserV2): User {
    const pm = u.public_metrics
    return {
      id: u.id,
      userName: u.username,
      name: u.name,
      isBlueVerified: u.verified ?? false,
      followers: pm?.followers_count ?? 0,
      following: pm?.following_count ?? 0,
      profilePicture: (u.profile_image_url ?? '').replace('_normal', ''),
      description: u.description ?? '',
      location: u.location,
      createdAt: u.created_at,
      statusesCount: pm?.tweet_count,
    }
  }
}

function unknownAuthor(): User {
  return {
    id: '', userName: 'unknown', name: 'Unknown', isBlueVerified: false,
    followers: 0, following: 0, profilePicture: '', description: '',
  }
}
